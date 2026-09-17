import type Database from "better-sqlite3";

import type { ControllerConfig } from "../config/controller-config";
import {
	recordWorkspaceCredential,
	staleWorkspaceCredentials,
} from "../db/workspace-repository";
import { parseRepository } from "../domain/repository";
import { type GitHubAppCredentials, installationToken } from "./github-app";
import type { Fetcher } from "./proxmox-http";
import { runSsh, type SshRunner } from "./ssh";
import { storeGitCredential } from "./workspace-checkout";

// CREDENTIAL_BATCH bounds how many credentials one pass will replace.
//
// Each costs a GitHub API call and an SSH connection, and the scheduler awaits the whole pass. The
// ones left over are simply the oldest next time, and the refresh window is wide enough that being
// a few minutes late is harmless.
const CREDENTIAL_BATCH = 4;

// refreshWorkspaceCredentials replaces git credentials before they expire.
//
// Installation tokens last an hour and workspaces last longer, so a credential minted at checkout
// is useless by the time an agent finishes its first real task. Pushing a fresh one down the SSH
// connection the controller already opens is what keeps `git push` working all day.
//
// Not an operation, for the same reason activity is not: nothing to resume, nothing to retry, and
// a failure only means the credential is replaced on the next pass instead.
export async function refreshWorkspaceCredentials(
	db: Database.Database,
	config: ControllerConfig,
	now: Date = new Date(),
	fetcher: Fetcher = fetch,
	ssh: SshRunner = runSsh,
): Promise<{ refreshed: number }> {
	const keyPath = config.WORKSPACE_SSH_KEY_PATH;
	const credentials = githubApp(config);
	if (keyPath === undefined || credentials === undefined) {
		return { refreshed: 0 };
	}

	const staleBefore = new Date(
		now.getTime() - config.GITHUB_TOKEN_REFRESH_SECONDS * 1_000,
	).toISOString();
	const workspaces = staleWorkspaceCredentials(
		db,
		staleBefore,
		CREDENTIAL_BATCH,
	);

	let refreshed = 0;
	for (const workspace of workspaces) {
		const repository = parseRepository(workspace.repository);
		if (repository.kind === "invalid") {
			continue;
		}

		const minted = await installationToken(credentials, repository, fetcher);
		if (minted.kind === "failed") {
			continue;
		}

		const stored = await storeGitCredential(
			{ address: workspace.ip, keyPath, user: config.WORKSPACE_SSH_USER },
			minted.token,
			ssh,
		);
		// Only a confirmed write moves the clock. Recording the attempt would leave a workspace
		// holding an expired credential while the controller believed it had a fresh one.
		if (stored.kind === "cloned") {
			recordWorkspaceCredential(db, workspace.id, now);
			refreshed += 1;
		}
	}

	return { refreshed };
}

function githubApp(config: ControllerConfig): GitHubAppCredentials | undefined {
	const appId = config.GITHUB_APP_ID;
	const installationId = config.GITHUB_APP_INSTALLATION_ID;
	const privateKeyPath = config.GITHUB_APP_PRIVATE_KEY_PATH;

	return appId === undefined ||
		installationId === undefined ||
		privateKeyPath === undefined
		? undefined
		: { appId, installationId, privateKeyPath };
}
