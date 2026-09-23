import type { SeedFileContent } from "../db/seed-file-repository";
import { AGENT_CWD } from "../domain/workspace-layout";

import type { SshRunner, SshTarget } from "./ssh";

// WorkspaceSeed is whether the operator's files reached the workspace.
export type WorkspaceSeed =
	| { failed: string; kind: "failed"; message: string }
	| { kind: "seeded" };

// MERGE_JSON folds a seeded JSON file into the one already in the workspace.
//
// Written over rather than merged, this file would take the onboarding and trust-dialog flags
// that `bootstrapAgentHome` wrote a step earlier, and the agent would stall on a first-run prompt
// with nobody there to answer it.
//
// The merge is deep and the seeded side wins at the leaves, so adding mcpServers leaves projects
// alone and adding one project leaves its siblings alone.
//
// Refuses rather than repairs. A file here that does not parse is either mid-write or something
// nobody predicted, and overwriting it to get the provision moving is how the flags are lost --
// which surfaces much later as an agent that never answers, rather than here as a step that
// failed with a reason. Deliberately no single quotes anywhere: this is embedded in a
// single-quoted shell word below.
const MERGE_JSON = [
	'const fs = require("fs");',
	"const file = process.argv[1];",
	"let incoming;",
	'try { incoming = JSON.parse(fs.readFileSync(0, "utf8")); }',
	'catch (error) { console.error("seeded .claude.json is not valid JSON: " + error.message); process.exit(1); }',
	"let existing = {};",
	'try { existing = JSON.parse(fs.readFileSync(file, "utf8")); }',
	'catch (error) { if (error.code !== "ENOENT") { console.error("the workspace .claude.json is not readable JSON: " + error.message); process.exit(1); } }',
	"function merge(base, over) {",
	'  if (over === null || typeof over !== "object" || Array.isArray(over)) { return over; }',
	'  const under = (base === null || typeof base !== "object" || Array.isArray(base)) ? {} : base;',
	"  const out = Object.assign({}, under);",
	"  for (const key of Object.keys(over)) { out[key] = merge(under[key], over[key]); }",
	"  return out;",
	"}",
	'fs.writeFileSync(file, JSON.stringify(merge(existing, incoming), null, 2) + "\\n", { mode: 0o600 });',
	// chmod as well as mode: writeFileSync only applies mode when it creates the file, and this
	// one already exists by the time seeding runs. Without this the merge silently inherits
	// whatever the file had, and this is a file an operator may well put a token in.
	"fs.chmodSync(file, 0o600);",
].join("\n");

// SEED_FILE_SCRIPT writes one file wherever its root says it belongs.
//
// The root is resolved here rather than on the controller because $HOME is not knowable from there,
// and a controller that guessed would be wrong the day the agent user changes.
//
// Fixed text with everything supplied positionally, per the rule this codebase learned the hard
// way: ssh joins its argv and the remote shell splits it again, so a path containing a space
// becomes two arguments and one containing a semicolon is remote code execution. The content goes
// on stdin -- not because it is secret, but because arguments are visible in `ps` and a seeded file
// is the one thing here an operator might reasonably put a credential in.
//
// The merge program above is fixed text for the same reason, and is the one branch that reads
// stdin with something other than `cat`.
const SEED_FILE_SCRIPT = [
	'case "$1" in',
	'  home) target="$HOME/$2" ;;',
	'  repo) target="$3/$2" ;;',
	'  *) target="$2" ;;',
	"esac",
	"umask 077",
	'mkdir -p "$(dirname "$target")" || exit 1',
	// Merged or written over, decided by the caller rather than by a filename in here. Which file
	// an agent writes for itself during bootstrap -- and therefore must not be clobbered -- is a
	// fact about that agent.
	'if [ "$4" = "merge" ]; then',
	`  node -e '${MERGE_JSON}' "$target"`,
	"else",
	'  cat > "$target"',
	"fi",
].join("\n");

// seedWorkspace writes every operator-uploaded file into one workspace.
//
// One connection per file rather than one carrying an archive. A handful of small files is the
// expected case, and the failure this shape gives -- "could not write .claude/settings.json" --
// names the file an operator has to go and fix, where an unpacking failure names none of them.
//
// Stops at the first failure. Carrying on would leave a workspace seeded with some of its
// configuration and no way to tell which, and the step is retried whole.
export async function seedWorkspace(
	target: SshTarget,
	harness: { merges(path: string): boolean },
	files: SeedFileContent[],
	ssh: SshRunner,
): Promise<WorkspaceSeed> {
	for (const file of files) {
		const merge =
			file.root === "home" && harness.merges(file.path) ? "merge" : "write";
		const result = await ssh(
			target,
			[
				"sh",
				"-c",
				SEED_FILE_SCRIPT,
				"sh",
				file.root,
				file.path,
				AGENT_CWD,
				merge,
			],
			file.content,
		);
		if (result.kind !== "ran" || result.code !== 0) {
			const reason =
				result.kind === "ran"
					? result.stderr.trim()
					: "workspace refused the connection";

			return {
				failed: file.path,
				kind: "failed",
				message: `could not write ${file.path}: ${reason || "unknown error"}`,
			};
		}
	}

	return { kind: "seeded" };
}
