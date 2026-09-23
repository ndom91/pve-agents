import type { Harness } from "../domain/harness";
import type { SshRunner, SshTarget } from "./ssh";

// AgentBootstrap is whether a workspace is ready for an agent to be started in it.
export type AgentBootstrap =
	| { kind: "failed"; message: string }
	| { kind: "prepared" };

// AGENT_ENV is the file every pane's shell sources to find its credentials.
const AGENT_ENV = "$HOME/.config/agent-env";

// SEED_SCRIPT writes whatever a harness needs to start without a human, and its credential.
//
// Generic over the harness by taking its files as alternating path and contents arguments, because
// what differs between agents is which files and what is in them, not how they are written. The
// credential still arrives on stdin and is written by `cat`, so it is never an argument to
// anything: Herdr's `workspace create --env` was simpler and put the token in the process list of
// every workspace for as long as the command ran.
//
// The bootstrap files are arguments rather than stdin, which is only one pipe. They are first-run
// flags, not secrets -- and if a harness ever needs a secret in one, that is the moment to give
// this a second channel rather than the moment to notice.
//
// Sourcing from .bashrc rather than .profile because a Herdr pane is an interactive non-login
// shell, which reads one and not the other. The guard makes a repeated bootstrap idempotent rather
// than appending the same line forever.
const SEED_SCRIPT = [
	"umask 077",
	'mkdir -p "$HOME/.config" "$1"',
	"shift",
	'while [ "$#" -ge 2 ]; do',
	'  mkdir -p "$(dirname "$1")"',
	'  printf %s "$2" > "$1"',
	"  shift 2",
	"done",
	`cat > "${AGENT_ENV}"`,
	`chmod 600 "${AGENT_ENV}"`,
	`grep -qF 'agent-env' "$HOME/.bashrc" 2>/dev/null || printf '%s\\n' '. "${AGENT_ENV}"' >> "$HOME/.bashrc"`,
].join("\n");

// agentEnvironment builds the line a pane's shell sources to find its credentials.
//
// Single-quoted with embedded quotes escaped, because this text is read by a shell: a credential
// containing a quote would otherwise end the string and have its remainder executed.
export function agentEnvironment(variable: string, token: string): string {
	const quoted = token.split("'").join(`'\\''`);

	return `export ${variable}='${quoted}'\n`;
}

// prepareAgentWorkspace seeds first-run state, credentials, and the directory to work in.
//
// All in one step because they are one idempotent write with nothing worth resuming between them.
// Rerunning repairs a partial result rather than compounding one.
export async function prepareAgentWorkspace(
	target: SshTarget,
	harness: Harness,
	input: { cwd: string; token: string },
	ssh: SshRunner,
): Promise<AgentBootstrap> {
	const files = harness
		.bootstrap(input.cwd)
		.flatMap((file) => [file.path, file.contents]);

	const result = await ssh(
		target,
		["sh", "-c", SEED_SCRIPT, "sh", input.cwd, ...files],
		agentEnvironment(harness.credential.env, input.token),
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
