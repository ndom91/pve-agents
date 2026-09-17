import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { Fetcher } from "./proxmox-http";

// GitHubAppCredentials is what the controller needs to act as its GitHub App.
export type GitHubAppCredentials = {
	appId: string;
	installationId: string;
	privateKeyPath: string;
};

// InstallationToken is a short-lived credential for exactly one repository.
export type InstallationToken =
	| { expiresAt: string; kind: "minted"; token: string }
	| { kind: "failed"; message: string };

// JWT_LIFETIME_SECONDS is how long the app assertion is valid for.
//
// GitHub rejects anything over ten minutes and rejects a future iat, so this sits comfortably
// inside both. It is only ever used to exchange for an installation token, immediately.
const JWT_LIFETIME_SECONDS = 540;

// CLOCK_SKEW_SECONDS backdates the assertion, because GitHub rejects one issued in its future and
// a controller clock a few seconds fast would otherwise fail every mint.
const CLOCK_SKEW_SECONDS = 60;

const GITHUB_API = "https://api.github.com";

// installationToken mints a credential scoped to a single repository.
//
// Scoped deliberately, even though the installation covers more. A workspace is handed the token
// for its own repository and nothing else, so the reach of a compromised agent is set here by the
// controller rather than by however broadly the App happens to be installed.
export async function installationToken(
	credentials: GitHubAppCredentials,
	repository: { name: string; owner: string },
	fetcher: Fetcher = fetch,
): Promise<InstallationToken> {
	const assertion = await appAssertion(credentials);
	if (assertion.kind === "failed") {
		return assertion;
	}

	try {
		const response = await fetcher(
			`${GITHUB_API}/app/installations/${credentials.installationId}/access_tokens`,
			{
				body: JSON.stringify({ repositories: [repository.name] }),
				headers: {
					accept: "application/vnd.github+json",
					authorization: `Bearer ${assertion.jwt}`,
					"content-type": "application/json",
				},
				method: "POST",
			},
		);
		if (!response.ok) {
			// GitHub's body echoes the request, so it is summarised to a status rather than
			// forwarded: these messages reach the workspace timeline.
			return {
				kind: "failed",
				message: `github refused an installation token with HTTP ${response.status}`,
			};
		}

		const body = (await response.json().catch(() => undefined)) as
			| { expires_at?: unknown; token?: unknown }
			| undefined;
		const token = typeof body?.token === "string" ? body.token : undefined;
		const expiresAt =
			typeof body?.expires_at === "string" ? body.expires_at : undefined;
		if (token === undefined || expiresAt === undefined) {
			return { kind: "failed", message: "github returned an unusable token" };
		}

		return { expiresAt, kind: "minted", token };
	} catch {
		return { kind: "failed", message: "github could not be reached" };
	}
}

// RepositoryAccess is whether the App can reach a repository.
//
// "unknown" is not "no". A controller that cannot reach GitHub knows nothing about the repository,
// and refusing the request would turn a GitHub outage into a controller outage.
export type RepositoryAccess =
	| { kind: "accessible" }
	| { kind: "inaccessible"; message: string }
	| { kind: "unknown" };

// repositoryAccess checks whether a repository can be cloned, before anything is built for it.
//
// Minting a scoped token is the check: GitHub refuses with 422 when the repository is not in the
// installation. Asking at request time turns a minute of provisioning followed by a failed clone
// into an immediate, readable answer.
export async function repositoryAccess(
	credentials: GitHubAppCredentials,
	repository: { name: string; owner: string },
	fetcher: Fetcher = fetch,
): Promise<RepositoryAccess> {
	const minted = await installationToken(credentials, repository, fetcher);
	if (minted.kind === "minted") {
		return { kind: "accessible" };
	}
	if (
		minted.message.includes("HTTP 422") ||
		minted.message.includes("HTTP 404")
	) {
		return {
			kind: "inaccessible",
			message: `${repository.owner}/${repository.name} is not available to this GitHub App installation`,
		};
	}

	return { kind: "unknown" };
}

// AppAssertion is the signed proof that this controller is the configured App.
type AppAssertion =
	| { jwt: string; kind: "signed" }
	| { kind: "failed"; message: string };

async function appAssertion(
	credentials: GitHubAppCredentials,
): Promise<AppAssertion> {
	let privateKey: string;
	try {
		privateKey = await readFile(credentials.privateKeyPath, "utf8");
	} catch {
		// Named rather than generic: an unreadable key is almost always ownership or mode on the
		// file, and saying which file turns a mystery into a one-line fix.
		return {
			kind: "failed",
			message: `github app private key could not be read from ${credentials.privateKeyPath}`,
		};
	}

	const issuedAt = Math.floor(Date.now() / 1000) - CLOCK_SKEW_SECONDS;
	const header = encode({ alg: "RS256", typ: "JWT" });
	const payload = encode({
		exp: issuedAt + JWT_LIFETIME_SECONDS,
		iat: issuedAt,
		iss: credentials.appId,
	});

	try {
		const signer = createSign("RSA-SHA256");
		signer.update(`${header}.${payload}`);
		signer.end();

		return {
			jwt: `${header}.${payload}.${signer.sign(privateKey, "base64url")}`,
			kind: "signed",
		};
	} catch {
		return {
			kind: "failed",
			message: "github app private key is not a usable RSA key",
		};
	}
}

function encode(value: Record<string, unknown>): string {
	return Buffer.from(JSON.stringify(value)).toString("base64url");
}
