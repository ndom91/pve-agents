// WorkspaceOutcome is what became of a workspace's work, once the container is gone.
//
// Derived from the timeline rather than stored, because the timeline already records every one of
// these and a second copy is a second thing to keep true. A push writes "pushed to pve-agents/<host>"
// the moment it succeeds; the container it happened on can be deleted an hour later without that
// sentence becoming any less accurate.
export type WorkspaceOutcome =
	| { branch: string; kind: "pushed"; url?: string }
	| { kind: "discarded" }
	| { kind: "lost" }
	| { kind: "nothing" };

// PUSHED is the note the push writes. Matched rather than parsed loosely, so a message that only
// mentions a branch in passing does not read as a successful push.
const PUSHED = /^pushed to (\S+)$/;

// workspaceOutcome reads what happened to the work.
//
// Order is the whole content. A push is preferred over every other signal, including the stored
// unsaved-work flag, because that flag is a cached observation and a push is a fact: a workspace
// that pushed and was then flagged by a check that could not see the branch is safe, and calling
// it lost would be the more alarming of the two possible mistakes.
export function workspaceOutcome(workspace: {
	events?: { eventType: string; message: string }[];
	repository?: string;
	unsavedWork?: boolean;
}): WorkspaceOutcome {
	const events = workspace.events ?? [];

	// Last rather than first: a workspace may push, carry on working, and push again, and the
	// branch named by the most recent one is where the work actually is.
	for (const event of [...events].reverse()) {
		const pushed =
			event.eventType === "workspace.pushed" && PUSHED.exec(event.message);
		if (pushed) {
			const branch = pushed[1] ?? "";

			return {
				branch,
				kind: "pushed",
				url: branchUrl(workspace.repository, branch),
			};
		}
	}

	if (workspace.unsavedWork === true) {
		return { kind: "lost" };
	}
	if (events.some((event) => event.eventType === "workspace.discarded")) {
		return { kind: "discarded" };
	}

	return { kind: "nothing" };
}

// branchUrl builds a link to the branch, when the repository is one that has a web address.
//
// Undefined rather than a guess for anything not recognisably GitHub. A link that 404s is worse
// than a branch name on its own, which at least tells you what to go and look for.
function branchUrl(repository?: string, branch?: string): string | undefined {
	if (repository === undefined || branch === undefined || branch === "") {
		return undefined;
	}

	const path = repository
		.replace(/^https?:\/\//, "")
		.replace(/\.git$/, "")
		.replace(/^git@github\.com:/, "github.com/");
	if (!path.startsWith("github.com/")) {
		return undefined;
	}

	return `https://${path}/tree/${branch}`;
}
