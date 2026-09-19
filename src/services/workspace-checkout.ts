import { repositoryURL } from "../domain/repository";
import type { SshRunner, SshTarget } from "./ssh";

// WorkspaceCheckout is whether a workspace now holds the repository it was requested for.
export type WorkspaceCheckout =
	| { kind: "cloned" }
	| { kind: "failed"; message: string };

// CREDENTIAL_SCRIPT stores a git credential that never appears anywhere it could be read from.
//
// This is the whole reason the clone happens in two steps rather than one. Putting the token in
// the URL, as `https://x-access-token:TOKEN@github.com/...`, leaks it twice over: into `ps` on the
// workspace for as long as git runs, and into the error text git prints on a failed fetch, which
// this controller then writes to the workspace timeline the UI renders.
//
// It arrives on stdin rather than as an argument, so it is not in the process list even for the
// instant this command takes. The clone that follows uses a credential-free URL and lets git read
// the stored value itself.
const CREDENTIAL_SCRIPT = [
	"umask 077",
	'cat > "$HOME/.git-credentials"',
	'chmod 600 "$HOME/.git-credentials"',
	"git config --global credential.helper store",
].join(" && ");

// CLONE_SCRIPT fills the working directory, and does nothing if it is already filled.
//
// Idempotent because a provision step may be retried after the clone succeeded but before the
// phase was recorded. Cloning again into a populated directory would fail, and failing on a
// repository that is already there is a worse answer than doing nothing.
const CLONE_SCRIPT = [
	'if [ ! -d "$1/.git" ]; then',
	'git clone --branch "$3" --single-branch "$2" "$1" || exit 1',
	"fi",
	// A single-branch clone narrows the fetch refspec to that one branch, and a narrow refspec has
	// a consequence a long way from here: a branch pushed later gets no remote-tracking ref, so
	// `git rev-parse @{u}` fails and the commit counts as unpushed forever. The workspace then
	// reports work it has already pushed, and the reaper, which asks the same question, never lets
	// it go. Widening this costs nothing and is what makes a successful push observable.
	//
	// Outside the guard above, so a workspace cloned before this existed is repaired rather than
	// skipped.
	'git -C "$1" config remote.origin.fetch "+refs/heads/*:refs/remotes/origin/*"',
].join("\n");

// IDENTITY_SCRIPT gives commits an author, since the agent will make them.
const IDENTITY_SCRIPT = [
	'git config --global user.name "$1"',
	'git config --global user.email "$2"',
].join(" && ");

// checkoutRepository puts a repository into the workspace, authenticated for later pushes.
//
// The credential is stored rather than used once: the agent pushes later under its own steam, and
// git reads the stored credential when it does.
export async function checkoutRepository(
	target: SshTarget,
	input: {
		cwd: string;
		ref: string;
		repository: { name: string; owner: string };
		token: string;
	},
	ssh: SshRunner,
): Promise<WorkspaceCheckout> {
	const stored = await storeGitCredential(target, input.token, ssh);
	if (stored.kind === "failed") {
		return stored;
	}

	const named = await run(
		target,
		[
			"sh",
			"-c",
			IDENTITY_SCRIPT,
			"sh",
			"pve-herdr-agents[bot]",
			"pve-herdr-agents[bot]@users.noreply.github.com",
		],
		ssh,
		input.token,
	);
	if (named.kind === "failed") {
		return named;
	}

	return run(
		target,
		[
			"sh",
			"-c",
			CLONE_SCRIPT,
			"sh",
			input.cwd,
			repositoryURL(input.repository),
			input.ref,
		],
		ssh,
		input.token,
	);
}

// storeGitCredential replaces the stored credential with a fresh one.
//
// Separate from checkout because an installation token lasts an hour and a workspace lasts longer:
// the credential has to be replaced on a living workspace, without touching its repository.
export async function storeGitCredential(
	target: SshTarget,
	token: string,
	ssh: SshRunner,
): Promise<WorkspaceCheckout> {
	return run(
		target,
		["sh", "-c", CREDENTIAL_SCRIPT],
		ssh,
		token,
		`https://x-access-token:${token}@github.com\n`,
	);
}

async function run(
	target: SshTarget,
	command: string[],
	ssh: SshRunner,
	token: string,
	input?: string,
): Promise<WorkspaceCheckout> {
	const result = await ssh(target, command, input);
	if (result.kind === "refused") {
		return { kind: "failed", message: "workspace refused the connection" };
	}
	if (result.kind === "rejected") {
		return { kind: "failed", message: redact(result.message, token) };
	}

	return result.code === 0
		? { kind: "cloned" }
		: {
				kind: "failed",
				message: redact(
					result.stderr.trim() || "git failed without output",
					token,
				),
			};
}

// redact keeps a credential out of anything an operator will read.
//
// git prints the remote it was using when a fetch fails, and these messages are appended to the
// workspace timeline. Scrubbing at the boundary covers every caller at once.
function redact(value: string, token: string): string {
	return token === "" ? value : value.split(token).join("[redacted]");
}
