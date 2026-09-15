import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { controllerConfig } from "../config/controller-config";
import { openDatabase } from "../db/database";
import {
	type ControllerAuth,
	createControllerAuth,
	issueControllerApiKey,
	migrateControllerAuth,
} from "./auth";
import { authorizeRequest } from "./authorize";

const SECRET = "t".repeat(48);

const databases: Database.Database[] = [];

afterEach(() => {
	for (const db of databases) {
		db.close();
	}

	databases.length = 0;
});

describe("authorizeRequest", () => {
	it("accepts a request carrying a minted key", async () => {
		const { auth, key } = await authenticated();

		expect(await authorize(auth, { "x-api-key": key })).toEqual({
			kind: "authorized",
		});
	});

	it("rejects a request with no key at all", async () => {
		const { auth } = await authenticated();

		expect(await authorize(auth, {})).toEqual({ kind: "unauthorized" });
		expect(await authorize(auth, { "x-api-key": "" })).toEqual({
			kind: "unauthorized",
		});
	});

	it("rejects a key that was never issued", async () => {
		const { auth } = await authenticated();

		expect(await authorize(auth, { "x-api-key": "not-a-real-key" })).toEqual({
			kind: "unauthorized",
		});
	});

	it("rejects a key from a different controller deployment", async () => {
		const { auth } = await authenticated();
		const other = await authenticated();

		expect(await authorize(auth, { "x-api-key": other.key })).toEqual({
			kind: "unauthorized",
		});
	});

	it("rejects a key that has been revoked", async () => {
		const { auth, db, key } = await authenticated();
		expect(await authorize(auth, { "x-api-key": key })).toEqual({
			kind: "authorized",
		});

		db.prepare("DELETE FROM apikey").run();

		expect(await authorize(auth, { "x-api-key": key })).toEqual({
			kind: "unauthorized",
		});
	});

	it("rejects a near-miss of a valid key", async () => {
		const { auth, key } = await authenticated();
		const tampered = `${key.slice(0, -1)}${key.endsWith("a") ? "b" : "a"}`;

		expect(await authorize(auth, { "x-api-key": tampered })).toEqual({
			kind: "unauthorized",
		});
	});

	it("stays open while no auth secret is configured", async () => {
		// Provisioning cannot be enabled without a secret, so this only ever applies to a
		// controller that is not touching real infrastructure.
		const { auth } = await authenticated();
		const open = controllerConfig({});

		expect(
			await authorizeRequest(new Request("http://c/"), open, auth),
		).toEqual({ kind: "authorized" });
	});
});

function authorize(auth: ControllerAuth, headers: Record<string, string>) {
	return authorizeRequest(
		new Request("http://controller.test/api/workspaces", {
			headers,
			method: "POST",
		}),
		config(),
		auth,
	);
}

async function authenticated(): Promise<{
	auth: ControllerAuth;
	db: Database.Database;
	key: string;
}> {
	const db = openDatabase(":memory:");
	databases.push(db);

	await migrateControllerAuth(db, config());
	const auth = createControllerAuth(db, config());

	return { auth, db, key: await issueControllerApiKey(auth, "test") };
}

function config() {
	return controllerConfig({ CONTROLLER_AUTH_SECRET: SECRET });
}
