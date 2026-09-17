import type { SshRunner, SshTarget } from "./ssh";

// ClaudeBootstrap is whether a workspace is ready for an agent to be started in it.
export type ClaudeBootstrap =
	| { kind: "failed"; message: string }
	| { kind: "prepared" };

// WIZARDS are the interactive gates Claude Code puts in front of a first run.
//
// Matched explicitly because the machine-readable state does not always give them away: Herdr
// reported the theme picker as agent_status "idle" with interactive_ready true, and `agent start`
// exited 0. A controller trusting that alone would send its first prompt into a menu.
const WIZARDS = [
	/Choose the text style/i,
	/Is this a project you created or one you trust/i,
	/Let's get started/i,
	/Select login method/i,
];

// SEED_SCRIPT writes the settings that let Claude Code start without a human.
//
// Fixed script text. The directory and the settings arrive as positional arguments, so neither is
// ever parsed as shell.
const SEED_SCRIPT = [
	"umask 077",
	'mkdir -p "$HOME/.claude" "$1"',
	'printf %s "$2" > "$HOME/.claude.json"',
].join("; ");

// claudeSeed builds the settings that skip every first-run gate for one working directory.
//
// Two separate gates, found the hard way, one at a time. hasCompletedOnboarding skips the theme
// picker. hasTrustDialogAccepted skips the "is this a folder you trust" prompt, which is per
// directory and which Herdr reports as a blocked agent.
export function claudeSeed(cwd: string): string {
	return JSON.stringify({
		hasCompletedOnboarding: true,
		projects: { [cwd]: { hasTrustDialogAccepted: true } },
	});
}

// prepareClaudeWorkspace seeds first-run settings and creates the directory the agent works in.
//
// Both happen together because they are one idempotent step with nothing worth resuming between
// them. Rerunning it repairs a partial result rather than compounding one.
export async function prepareClaudeWorkspace(
	target: SshTarget,
	cwd: string,
	ssh: SshRunner,
): Promise<ClaudeBootstrap> {
	const result = await ssh(target, [
		"sh",
		"-c",
		SEED_SCRIPT,
		"sh",
		cwd,
		claudeSeed(cwd),
	]);
	if (result.kind === "refused") {
		return { kind: "failed", message: "workspace refused the connection" };
	}
	if (result.kind === "rejected") {
		return { kind: "failed", message: result.message };
	}
	if (result.code !== 0) {
		return {
			kind: "failed",
			message: result.stderr.trim() || "workspace bootstrap failed",
		};
	}

	return { kind: "prepared" };
}

// claudeAwaitingInput reports whether a pane is showing a first-run gate.
export function claudeAwaitingInput(pane: string): boolean {
	return WIZARDS.some((wizard) => wizard.test(pane));
}
