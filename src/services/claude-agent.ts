import type { SshRunner, SshTarget } from "./ssh";

// ClaudeBootstrap is whether a workspace is ready for an agent to be started in it.
export type ClaudeBootstrap =
	| { kind: "failed"; message: string }
	| { kind: "prepared" };

// AGENT_ENV is the file every pane's shell sources to find its credentials.
const AGENT_ENV = "$HOME/.config/agent-env";

// SEED_SCRIPT writes the settings and credentials that let Claude Code start without a human.
//
// The credential arrives on stdin and is written by `cat`, so it is never an argument to anything.
// Herdr's `workspace create --env` would have been simpler and was how this worked first, but that
// puts the token in the process list of every workspace for as long as the command runs.
//
// Sourcing from .bashrc rather than .profile because a Herdr pane is an interactive non-login
// shell, which reads one and not the other. The guard makes a repeated bootstrap idempotent rather
// than appending the same line forever.
const SEED_SCRIPT = [
	"umask 077",
	'mkdir -p "$HOME/.claude" "$HOME/.config" "$1"',
	'printf %s "$2" > "$HOME/.claude.json"',
	`cat > "${AGENT_ENV}"`,
	`chmod 600 "${AGENT_ENV}"`,
	`grep -qF 'agent-env' "$HOME/.bashrc" 2>/dev/null || printf '%s\\n' '. "${AGENT_ENV}"' >> "$HOME/.bashrc"`,
].join("\n");

// claudeSeed builds the settings that skip every first-run gate for one working directory.
//
// Two separate gates, found the hard way, one at a time. hasCompletedOnboarding skips the theme
// picker. hasTrustDialogAccepted skips the "is this a folder you trust" prompt, which is recorded
// per directory.
//
// Kept after the TUI was retired, deliberately. Both gates belonged to the interactive client and
// the SDK very probably asks neither — but "very probably" is not a thing to find out by having
// every new workspace fail to start. It is one small file written once during bootstrap, and every
// workspace verified so far was verified with it in place. Removing it is a change to make on
// purpose, with a workspace provisioned without it to prove the point.
export function claudeSeed(cwd: string): string {
	return JSON.stringify({
		hasCompletedOnboarding: true,
		projects: { [cwd]: { hasTrustDialogAccepted: true } },
	});
}

// agentEnvironment builds the line a pane's shell sources to find its credentials.
//
// Single-quoted with embedded quotes escaped, because this text is read by a shell: a credential
// containing a quote would otherwise end the string and have its remainder executed.
export function agentEnvironment(token: string): string {
	const quoted = token.split("'").join(`'\\''`);

	return `export CLAUDE_CODE_OAUTH_TOKEN='${quoted}'\n`;
}

// prepareClaudeWorkspace seeds first-run settings, credentials, and the directory to work in.
//
// All in one step because they are one idempotent write with nothing worth resuming between them.
// Rerunning repairs a partial result rather than compounding one.
export async function prepareClaudeWorkspace(
	target: SshTarget,
	input: { cwd: string; token: string },
	ssh: SshRunner,
): Promise<ClaudeBootstrap> {
	const result = await ssh(
		target,
		["sh", "-c", SEED_SCRIPT, "sh", input.cwd, claudeSeed(input.cwd)],
		agentEnvironment(input.token),
	);
	if (result.kind === "refused") {
		return { kind: "failed", message: "workspace refused the connection" };
	}
	if (result.kind === "rejected") {
		return { kind: "failed", message: redact(result.message, input.token) };
	}
	if (result.code !== 0) {
		return {
			kind: "failed",
			message: redact(
				result.stderr.trim() || "workspace bootstrap failed",
				input.token,
			),
		};
	}

	return { kind: "prepared" };
}

function redact(value: string, token: string): string {
	return token === "" ? value : value.split(token).join("[redacted]");
}
