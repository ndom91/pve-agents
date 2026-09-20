import { describe, expect, it } from "vitest";

import { workspaceOutcome } from "./workspace-outcome";

const REPOSITORY = "github.com/ndom91/open-plan-annotator";

function pushed(branch: string) {
	return { eventType: "workspace.pushed", message: `pushed to ${branch}` };
}

describe("workspaceOutcome", () => {
	it("finds the branch the work went to", () => {
		expect(
			workspaceOutcome({
				events: [pushed("pve-agents/agent-8d1f")],
				repository: REPOSITORY,
			}),
		).toEqual({
			branch: "pve-agents/agent-8d1f",
			kind: "pushed",
			url: "https://github.com/ndom91/open-plan-annotator/tree/pve-agents/agent-8d1f",
		});
	});

	it("prefers a push over a stale unsaved-work flag", () => {
		// The flag is a cached observation and the push is a fact. A workspace that pushed and was
		// then flagged by a check that could not see the branch is safe, and "lost" is the more
		// alarming of the two possible mistakes. This is not hypothetical: a narrow fetch refspec
		// produced exactly that pair on a real workspace.
		expect(
			workspaceOutcome({
				events: [pushed("pve-agents/agent-8d1f")],
				repository: REPOSITORY,
				unsavedWork: true,
			}).kind,
		).toBe("pushed");
	});

	it("takes the last push when there were several", () => {
		// A workspace can push, carry on working, and push again. The branch named by the most
		// recent one is where the work actually is.
		const outcome = workspaceOutcome({
			events: [pushed("pve-agents/old"), pushed("pve-agents/new")],
			repository: REPOSITORY,
		});

		expect(outcome).toMatchObject({ branch: "pve-agents/new" });
	});

	it("calls unpushed work lost rather than discarded", () => {
		// Both can be true at once: a workspace that discarded a scratch file and still held a
		// commit nobody kept. The loss is the part worth reporting.
		expect(
			workspaceOutcome({
				events: [{ eventType: "workspace.discarded", message: "discarded" }],
				unsavedWork: true,
			}).kind,
		).toBe("lost");
	});

	it("reports a discard when nothing was left behind", () => {
		expect(
			workspaceOutcome({
				events: [{ eventType: "workspace.discarded", message: "discarded" }],
				unsavedWork: false,
			}).kind,
		).toBe("discarded");
	});

	it("says nothing happened when nothing did", () => {
		expect(workspaceOutcome({ events: [] }).kind).toBe("nothing");
		expect(workspaceOutcome({}).kind).toBe("nothing");
	});

	it("does not read a passing mention as a push", () => {
		// The message has to be the note the push writes, not any sentence containing a branch.
		expect(
			workspaceOutcome({
				events: [
					{
						eventType: "workspace.kept",
						message: "kept rather than destroyed: pushed to nowhere yet",
					},
				],
			}).kind,
		).toBe("nothing");
	});

	it("offers no link for a repository it cannot address", () => {
		// A link that 404s is worse than a branch name alone, which at least says what to look for.
		const outcome = workspaceOutcome({
			events: [pushed("pve-agents/agent-1")],
			repository: "gitlab.example.internal/team/thing",
		});

		expect(outcome).toEqual({
			branch: "pve-agents/agent-1",
			kind: "pushed",
			url: undefined,
		});
	});

	it("addresses an ssh remote and a .git suffix", () => {
		const outcome = workspaceOutcome({
			events: [pushed("pve-agents/agent-1")],
			repository: "git@github.com:ndom91/thing.git",
		});

		expect(outcome).toMatchObject({
			url: "https://github.com/ndom91/thing/tree/pve-agents/agent-1",
		});
	});
});
