import { type ListeningPort, readListeningPorts } from "../domain/port";
import type { SshRunner, SshTarget } from "./ssh";

// WorkspacePorts is what is listening in one container, or why that is not known.
export type WorkspacePorts =
	| { kind: "listed"; ports: ListeningPort[] }
	| { kind: "unavailable"; message: string };

// LISTEN_SCRIPT asks what is listening, and what each listener was started in.
//
// One round trip for both, rather than one SSH per dev server to fill a column. `ss` runs once,
// so the pids come from the same snapshot as the rows. `-H` drops the header. `-n` keeps ports
// numeric, or 22 arrives as "ssh".
//
// The cwds follow a sentinel as "pid<TAB>path" lines. readlink may fail, for a process that exited
// in between, and the loop carries on.
const SENTINEL = "---CWD---";
const LISTEN_SCRIPT = [
	"listing=$(ss -tlnpH) || exit",
	"printf '%s\\n' \"$listing\"",
	`printf '%s\\n' '${SENTINEL}'`,
	"for pid in $(printf '%s\\n' \"$listing\" | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u); do",
	'  target=$(readlink "/proc/$pid/cwd" 2>/dev/null) || continue',
	'  printf \'%s\\t%s\\n\' "$pid" "$target"',
	"done",
].join("\n");

// listeningPorts reads what is listening inside a workspace, live.
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

// cwds turns the "pid<TAB>path" trailer into a lookup. Split on the first tab only, since a path
// can contain one.
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
