import type { SeedFileContent } from "../db/seed-file-repository";
import { AGENT_CWD } from "../domain/workspace-layout";

import type { SshRunner, SshTarget } from "./ssh";

// WorkspaceSeed is whether the operator's files reached the workspace.
export type WorkspaceSeed =
	| { failed: string; kind: "failed"; message: string }
	| { kind: "seeded" };

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
const SEED_FILE_SCRIPT = [
	'case "$1" in',
	'  home) target="$HOME/$2" ;;',
	'  repo) target="$3/$2" ;;',
	'  *) target="$2" ;;',
	"esac",
	"umask 077",
	'mkdir -p "$(dirname "$target")" || exit 1',
	'cat > "$target"',
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
	files: SeedFileContent[],
	ssh: SshRunner,
): Promise<WorkspaceSeed> {
	for (const file of files) {
		const result = await ssh(
			target,
			["sh", "-c", SEED_FILE_SCRIPT, "sh", file.root, file.path, AGENT_CWD],
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
