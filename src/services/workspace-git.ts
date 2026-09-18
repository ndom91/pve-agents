import type { SshRunner, SshTarget } from "./ssh";

// UnsavedWork is whether a workspace still holds something that would die with it.
//
// "unknown" is not "clean", and the distinction decides whether a container is destroyed. A
// workspace that cannot be inspected has not been shown to be safe, and treating silence as
// permission is how work gets lost.
export type UnsavedWork =
	| { kind: "clean" }
	| { kind: "unknown"; message: string }
	| { kind: "unsaved"; reason: string };

// UNSAVED is the exit status meaning the tree holds work. Anything else non-zero is a fault, so
// the two cannot be confused: the script says which by how it exits rather than by what it prints.
const UNSAVED = 10;

// CHECK looks for anything that would not survive the container.
//
// Two separate losses. Uncommitted changes are the obvious one. Commits that were never pushed are
// the quieter one: an agent that committed neatly and stopped has work just as lost as one that
// left the tree dirty, and a branch with no upstream at all has never been anywhere else.
//
// Ignored files are excluded by git status, which is what keeps this from being permanently true
// for any repository with a build directory.
const CHECK = [
	'cd "$1" || exit 3',
	"git rev-parse --git-dir >/dev/null 2>&1 || exit 4",
	`[ -n "$(git status --porcelain)" ] && exit ${UNSAVED}`,
	'upstream=$(git rev-parse --abbrev-ref "@{u}" 2>/dev/null || true)',
	`[ -z "$upstream" ] && [ -n "$(git log --oneline -1 2>/dev/null)" ] && exit ${UNSAVED}`,
	`[ -n "$upstream" ] && [ -n "$(git log --oneline "$upstream"..HEAD 2>/dev/null)" ] && exit ${UNSAVED}`,
	"exit 0",
].join("\n");

// workspaceUnsavedWork reports whether a workspace holds work nobody has kept.
export async function workspaceUnsavedWork(
	target: SshTarget,
	cwd: string,
	ssh: SshRunner,
): Promise<UnsavedWork> {
	const result = await ssh(target, ["sh", "-c", CHECK, "sh", cwd]);
	if (result.kind === "refused") {
		return { kind: "unknown", message: "workspace refused the connection" };
	}
	if (result.kind === "rejected") {
		return { kind: "unknown", message: result.message };
	}
	if (result.code === UNSAVED) {
		return { kind: "unsaved", reason: "uncommitted or unpushed changes" };
	}
	if (result.code === 0) {
		return { kind: "clean" };
	}

	// A missing directory or a path that is not a repository. Not "clean": the checkout may have
	// failed, and something else may be on that disk.
	return {
		kind: "unknown",
		message:
			result.code === 3 || result.code === 4
				? `${cwd} is not a readable git repository`
				: result.stderr.trim() || `git check exited ${result.code}`,
	};
}
