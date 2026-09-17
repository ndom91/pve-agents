import { generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { installationToken } from "./github-app";

const KEY_PATH = join(tmpdir(), "pve-herdr-agents-github-app.pem");

const CREDENTIALS = {
	appId: "123456",
	installationId: "7890",
	privateKeyPath: KEY_PATH,
};

const REPOSITORY = { name: "open-plan-annotator", owner: "ndom91" };

beforeAll(() => {
	const { privateKey } = generateKeyPairSync("rsa", {
		modulusLength: 2048,
		privateKeyEncoding: { format: "pem", type: "pkcs1" },
		publicKeyEncoding: { format: "pem", type: "spki" },
	});
	writeFileSync(KEY_PATH, privateKey, { mode: 0o600 });
});

describe("installationToken", () => {
	it("asks for a token scoped to one repository", async () => {
		// The installation may cover every repository in the account. Naming one here is what
		// limits a compromised workspace to its own, so it is the security boundary, not a detail.
		let body: unknown;
		await installationToken(CREDENTIALS, REPOSITORY, async (_url, init) => {
			body = JSON.parse(String(init?.body));

			return Response.json({ expires_at: "2026-01-01T01:00:00Z", token: "t" });
		});

		expect(body).toEqual({ repositories: ["open-plan-annotator"] });
	});

	it("signs an assertion GitHub will accept", async () => {
		let authorization = "";
		await installationToken(CREDENTIALS, REPOSITORY, async (_url, init) => {
			authorization = String(
				(init?.headers as Record<string, string>).authorization,
			);

			return Response.json({ expires_at: "2026-01-01T01:00:00Z", token: "t" });
		});

		const [, payload] = authorization.replace("Bearer ", "").split(".");
		const claims = JSON.parse(
			Buffer.from(String(payload), "base64url").toString(),
		) as { exp: number; iat: number; iss: string };

		expect(claims.iss).toBe("123456");
		// GitHub rejects an assertion issued in its own future, so this is backdated on purpose.
		expect(claims.iat).toBeLessThan(Math.floor(Date.now() / 1000));
		// And rejects a lifetime over ten minutes.
		expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
	});

	it("uses the installation it was configured with", async () => {
		let requested = "";
		await installationToken(CREDENTIALS, REPOSITORY, async (url) => {
			requested = String(url);

			return Response.json({ expires_at: "2026-01-01T01:00:00Z", token: "t" });
		});

		expect(requested).toBe(
			"https://api.github.com/app/installations/7890/access_tokens",
		);
	});

	it("returns the token and its expiry", async () => {
		const minted = await installationToken(CREDENTIALS, REPOSITORY, async () =>
			Response.json({
				expires_at: "2026-01-01T01:00:00Z",
				token: "ghs_minted",
			}),
		);

		expect(minted).toEqual({
			expiresAt: "2026-01-01T01:00:00Z",
			kind: "minted",
			token: "ghs_minted",
		});
	});

	it("summarises a refusal rather than forwarding GitHub's body", async () => {
		// The body echoes the request back, and these messages are written to the workspace
		// timeline the UI renders.
		const refused = await installationToken(
			CREDENTIALS,
			REPOSITORY,
			async () => new Response("{}", { status: 403 }),
		);

		expect(refused).toEqual({
			kind: "failed",
			message: "github refused an installation token with HTTP 403",
		});
	});

	it("reports an unreadable key by name instead of throwing", async () => {
		// Almost always ownership or mode on the file, so naming it turns a mystery into a
		// one-line fix.
		const failed = await installationToken(
			{ ...CREDENTIALS, privateKeyPath: "/nonexistent/app.pem" },
			REPOSITORY,
			async () => {
				throw new Error("github must not be reached without a key");
			},
		);

		expect(failed.kind).toBe("failed");
		expect(JSON.stringify(failed)).toContain("/nonexistent/app.pem");
	});

	it("does not throw when GitHub cannot be reached", async () => {
		const failed = await installationToken(
			CREDENTIALS,
			REPOSITORY,
			async () => {
				throw new Error("network down");
			},
		);

		expect(failed).toEqual({
			kind: "failed",
			message: "github could not be reached",
		});
	});
});
