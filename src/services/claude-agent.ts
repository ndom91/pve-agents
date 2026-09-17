import type { SshRunner, SshTarget } from "./ssh";

// ClaudeBootstrap is whether a workspace is ready for an agent to be started in it.
export type ClaudeBootstrap =
	| { kind: "failed"; message: string }
	| { kind: "prepared" };

// ONBOARDING is the first-run state Claude Code shows before it has been configured.
//
// Worth matching explicitly because Herdr reports this screen as agent_status "idle" with
// interactive_ready true, and `agent start` exits 0. Nothing in the machine-readable response
// distinguishes a usable agent from a theme picker, so the screen itself is the only evidence. A
// controller that skipped this check would send its first prompt into a menu.
const ONBOARDING = [
	/Choose the text style/i,
	/Let's get started/i,
	/Select login method/i,
];

// SEED prepares a home directory for a non-interactive first run.
//
// hasCompletedOnboarding is the single flag gating the first-run wizard; theme may stay unset. The
// file is written whole rather than merged because a freshly cloned workspace has no prior state,
// and umask keeps it private since Claude Code also stores account details here later.
//
// Fixed script text with the path supplied positionally, so nothing is parsed as shell.
const SEED = [
	"umask 077",
	'mkdir -p "$HOME/.claude" "$1"',
	'printf %s \'{"hasCompletedOnboarding":true}\' > "$HOME/.claude.json"',
].join("; ");

// prepareClaudeWorkspace seeds onboarding state and creates the directory the agent will work in.
//
// Both are done together because they are one idempotent step with nothing to resume between them.
export async function prepareClaudeWorkspace(
	target: SshTarget,
	cwd: string,
	ssh: SshRunner,
): Promise<ClaudeBootstrap> {
	const result = await ssh(target, ["sh", "-c", SEED, "sh", cwd]);
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

// claudeAwaitingOnboarding reports whether a pane is showing the first-run wizard.
export function claudeAwaitingOnboarding(pane: string): boolean {
	return ONBOARDING.some((marker) => marker.test(pane));
}
