import { spawn } from "node:child_process";
import { dirname, join } from "node:path";

// SshTarget is everything needed to reach one workspace.
export type SshTarget = {
	address: string;
	keyPath: string;
	user: string;
};

// SshResult separates a workspace that is not up yet from one that never will be.
//
// The distinction decides whether the controller retries or gives up, and getting it wrong is
// expensive in both directions: retrying a wrong key burns an hour, and giving up on a container
// that is still booting throws away a working workspace.
export type SshResult =
	| { code: number; kind: "ran"; stderr: string; stdout: string }
	| { kind: "refused" }
	| { kind: "rejected"; message: string };

// SshRunner is the injection point for SSH, mirroring how Proxmox calls take a Fetcher: tests
// must not spawn a real client or depend on a reachable network.
export type SshRunner = (
	target: SshTarget,
	command: string[],
) => Promise<SshResult>;

// SSH_TIMEOUT_SECONDS bounds a single connection attempt. Readiness is retried by the worker, so
// this only needs to be long enough for a booted container to answer.
const SSH_TIMEOUT_SECONDS = 10;

// quoteRemote makes one argument survive the remote shell intact.
//
// ssh does not preserve argv boundaries. It joins the command it is given with spaces and hands
// the result to the remote login shell, which splits it again on whitespace and interprets every
// metacharacter in it. Callers reasonably expect an array of arguments to behave like one, so the
// quoting that makes that true belongs here rather than in each of them.
//
// Without it, an argument containing a space silently becomes two, and a repository name, ref, or
// agent prompt carrying a semicolon is remote code execution under the controller's own key.
export function quoteRemote(command: string[]): string {
	return command
		.map((argument) => `'${argument.split("'").join(`'\\''`)}'`)
		.join(" ");
}

// runSsh executes one command on a workspace.
export function runSsh(
	target: SshTarget,
	command: string[],
): Promise<SshResult> {
	return new Promise((resolve) => {
		const ssh = spawn(
			"ssh",
			[
				"-i",
				target.keyPath,
				"-o",
				"BatchMode=yes",
				"-o",
				`ConnectTimeout=${SSH_TIMEOUT_SECONDS}`,
				// Trust on first use, then pin. A changed host key after that is refused rather
				// than silently accepted, which is the only thing standing between a recycled
				// VMID and the controller handing credentials to the wrong container.
				"-o",
				"StrictHostKeyChecking=accept-new",
				"-o",
				`UserKnownHostsFile=${knownHostsPath(target.keyPath)}`,
				"-o",
				"LogLevel=ERROR",
				`${target.user}@${target.address}`,
				"--",
				quoteRemote(command),
			],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);

		let stdout = "";
		let stderr = "";
		ssh.stdout.on("data", (chunk) => {
			stdout += String(chunk);
		});
		ssh.stderr.on("data", (chunk) => {
			stderr += String(chunk);
		});

		ssh.on("error", () => {
			resolve({ kind: "rejected", message: "ssh could not be executed" });
		});

		ssh.on("close", (code) => {
			// 255 is ssh's own failure, as distinct from the remote command's exit status.
			if (code !== 255) {
				resolve({ code: code ?? 0, kind: "ran", stderr, stdout });

				return;
			}

			resolve(classify(stderr));
		});
	});
}

// knownHostsPath keeps pinned host keys beside the controller's private key.
export function knownHostsPath(keyPath: string): string {
	return join(dirname(keyPath), "known_hosts");
}

// forgetHost drops a pinned host key, so a recycled address is trusted afresh.
//
// Without this a destroyed workspace's key stays pinned, and the next workspace handed that
// address fails host verification for a reason that looks nothing like the cause.
export function forgetHost(keyPath: string, address: string): Promise<void> {
	return new Promise((resolve) => {
		const removal = spawn(
			"ssh-keygen",
			["-f", knownHostsPath(keyPath), "-R", address],
			{ stdio: "ignore" },
		);

		removal.on("error", () => resolve());
		removal.on("close", () => resolve());
	});
}

function classify(stderr: string): SshResult {
	// Still coming up. Every one of these resolves itself once sshd is listening.
	if (
		/connection refused|connection timed out|no route to host|network is unreachable|connection closed|reset by peer/i.test(
			stderr,
		)
	) {
		return { kind: "refused" };
	}

	// Retrying will not fix any of these. A changed host key in particular deserves a human.
	return { kind: "rejected", message: stderr.trim() || "ssh failed" };
}
