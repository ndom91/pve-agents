import { type ListeningPort, readListeningPorts } from "../domain/port";
import type { SshRunner, SshTarget } from "./ssh";

// WorkspacePorts is what is listening in one container, or why that is not known.
export type WorkspacePorts =
	| { kind: "listed"; ports: ListeningPort[] }
	| { kind: "unavailable"; message: string };

// LISTEN_SCRIPT asks what is listening, and what each listener was started in.
//
// One round trip for both. The working directories could be read per process afterwards, but that
// is one SSH connection per dev server to fill a column, and the operator opened a tab rather than
// asked a question.
//
// `-H` drops the header row, so the parser never has to recognise and skip it. `-n` keeps ports
// numeric: without it 22 arrives as "ssh" and 5173 stays 5173, which is two formats in one column.
//
// The cwds come back as "pid<TAB>path" lines after a sentinel. readlink is allowed to fail and the
// loop carries on: /proc/<pid>/cwd is readable only by the owner, and a process that exits between
// the two commands leaves a pid pointing at nothing.
const SENTINEL = "---CWD---";
const LISTEN_SCRIPT = [
	"ss -tlnpH",
	`printf '%s\\n' '${SENTINEL}'`,
	"for pid in $(ss -tlnpH | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u); do",
	'  target=$(readlink "/proc/$pid/cwd" 2>/dev/null) || continue',
	'  printf \'%s\\t%s\\n\' "$pid" "$target"',
	"done",
].join("\n");

// listeningPorts reads what is listening inside a workspace.
//
// Read live rather than recorded, because a dev server is started and stopped by hand while the
// page is open and a cached answer is worse than none: an operator clicking a link to a port that
// closed a minute ago gets a browser error and no idea why.
export async function listeningPorts(
	target: SshTarget,
	ssh: SshRunner,
): Promise<WorkspacePorts> {
	const result = await ssh(target, ["sh", "-c", LISTEN_SCRIPT]);
	if (result.kind === "refused") {
		return { kind: "unavailable", message: "the workspace is not reachable" };
	}
	if (result.kind !== "ran" || result.code !== 0) {
		const said = result.kind === "ran" ? result.stderr.trim() : "";

		return { kind: "unavailable", message: said || "could not list ports" };
	}

	const cut = result.stdout.indexOf(SENTINEL);
	const listing = cut === -1 ? result.stdout : result.stdout.slice(0, cut);
	const trailer = cut === -1 ? "" : result.stdout.slice(cut + SENTINEL.length);

	return { kind: "listed", ports: readListeningPorts(listing, cwds(trailer)) };
}

// cwds turns the "pid<TAB>path" trailer into a lookup.
//
// A path can contain a tab, so this splits on the first one only: the pid is the part before it and
// everything after is the directory, however many tabs are in it.
function cwds(trailer: string): Record<number, string> {
	const found: Record<number, string> = {};
	for (const line of trailer.split("\n")) {
		const tab = line.indexOf("\t");
		if (tab === -1) {
			continue;
		}

		const pid = Number(line.slice(0, tab).trim());
		const path = line.slice(tab + 1).trim();
		if (Number.isFinite(pid) && path !== "") {
			found[pid] = path;
		}
	}

	return found;
}
