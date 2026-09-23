import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "./database";
import {
	deleteHarness,
	enabledHarnesses,
	harnesses,
	harnessSecret,
	saveHarness,
} from "./harness-repository";

const databases: Database.Database[] = [];

afterEach(() => {
	for (const db of databases) {
		db.close();
	}

	databases.length = 0;
});

function open(): Database.Database {
	const db = openDatabase(":memory:");
	databases.push(db);

	return db;
}

const CLAUDE = {
	credential: "sk-ant-oat01-not-a-real-token",
	enabled: true,
	kind: "claude-code",
	name: "Claude",
	permissionMode: "auto",
};

describe("saveHarness", () => {
	it("stores one and gives it back without its credential", async () => {
		const db = open();

		const saved = saveHarness(db, CLAUDE);

		expect(saved.kind).toBe("saved");
		expect(saved.kind === "saved" && saved.harness).toMatchObject({
			enabled: true,
			hasCredential: true,
			kind: "claude-code",
			name: "Claude",
			permissionMode: "auto",
		});
		// The shape has no credential field, so this asserts the type is doing its job rather than
		// that someone remembered a delete.
		expect(JSON.stringify(saved)).not.toContain("sk-ant-oat01");
	});

	it("refuses a second harness with the same name", () => {
		// Two rows called the same thing is a dropdown an operator cannot choose from, and a
		// last-writer-wins they have no way to see.
		const db = open();
		saveHarness(db, CLAUDE);

		const again = saveHarness(db, { ...CLAUDE, credential: "another" });

		expect(again).toEqual({
			kind: "invalid",
			message: 'another harness is already called "Claude"',
		});
	});

	it("refuses a new harness with no credential", () => {
		// It could not do anything, and letting the row exist pushes the discovery into
		// provisioning, which is the worst place for it.
		const db = open();

		expect(saveHarness(db, { ...CLAUDE, credential: "" })).toEqual({
			kind: "invalid",
			message: "a credential is required",
		});
	});

	it("keeps the stored credential when an edit leaves the field blank", () => {
		// The rule this file exists for. An operator renaming a harness must not blank its token and
		// find out at the next provision.
		const db = open();
		const first = saveHarness(db, CLAUDE);
		const id = first.kind === "saved" ? first.harness.id : "";

		saveHarness(db, { ...CLAUDE, credential: "", id, name: "Claude renamed" });

		expect(harnessSecret(db, id)).toMatchObject({
			credential: "sk-ant-oat01-not-a-real-token",
			name: "Claude renamed",
		});
	});

	it("replaces the credential when one is given", () => {
		const db = open();
		const first = saveHarness(db, CLAUDE);
		const id = first.kind === "saved" ? first.harness.id : "";

		saveHarness(db, { ...CLAUDE, credential: "rotated", id });

		expect(harnessSecret(db, id)?.credential).toBe("rotated");
	});

	it("refuses an edit to a harness that has been deleted", () => {
		const db = open();

		expect(saveHarness(db, { ...CLAUDE, id: "gone" })).toEqual({
			kind: "invalid",
			message: "that harness no longer exists",
		});
	});

	it("stores an absent model as absent rather than as an empty string", () => {
		// The runner reads an empty model as "use your own default", and so does an absent one, but
		// only one of them is true. A row saying the operator chose "" is a row that lies.
		const db = open();
		const saved = saveHarness(db, { ...CLAUDE, model: "" });

		expect(saved.kind === "saved" && saved.harness.model).toBeUndefined();
	});
});

describe("harnesses", () => {
	it("lists them by name, never with a credential", () => {
		const db = open();
		saveHarness(db, { ...CLAUDE, name: "Zebra" });
		saveHarness(db, { ...CLAUDE, credential: "x", name: "Alpha" });

		const listed = harnesses(db);

		expect(listed.map((harness) => harness.name)).toEqual(["Alpha", "Zebra"]);
		expect(JSON.stringify(listed)).not.toContain("sk-ant-oat01");
	});

	it("offers only the enabled ones for launching", () => {
		// The settings page shows the disabled ones -- that is how they get re-enabled -- and the
		// launch form must not.
		const db = open();
		saveHarness(db, CLAUDE);
		saveHarness(db, {
			...CLAUDE,
			credential: "x",
			enabled: false,
			name: "Retired",
		});

		expect(enabledHarnesses(db).map((harness) => harness.name)).toEqual([
			"Claude",
		]);
		expect(harnesses(db)).toHaveLength(2);
	});
});

describe("harnessSecret", () => {
	it("is the one reader that returns a credential", () => {
		const db = open();
		const saved = saveHarness(db, CLAUDE);
		const id = saved.kind === "saved" ? saved.harness.id : "";

		expect(harnessSecret(db, id)?.credential).toBe(
			"sk-ant-oat01-not-a-real-token",
		);
	});

	it("says nothing rather than throwing for an id that is gone", () => {
		expect(harnessSecret(open(), "gone")).toBeUndefined();
	});
});

describe("deleteHarness", () => {
	it("removes it", () => {
		const db = open();
		const saved = saveHarness(db, CLAUDE);
		const id = saved.kind === "saved" ? saved.harness.id : "";

		deleteHarness(db, id);

		expect(harnesses(db)).toEqual([]);
	});

	it("frees the name for reuse", () => {
		const db = open();
		const saved = saveHarness(db, CLAUDE);
		deleteHarness(db, saved.kind === "saved" ? saved.harness.id : "");

		expect(saveHarness(db, CLAUDE).kind).toBe("saved");
	});
});
