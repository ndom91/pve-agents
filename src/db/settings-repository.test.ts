import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "./database";
import {
	controllerSettings,
	updateControllerSettings,
} from "./settings-repository";

const databases: Database.Database[] = [];

afterEach(() => {
	for (const db of databases) {
		db.close();
	}

	databases.length = 0;
});

describe("controllerSettings", () => {
	it("runs a never-configured controller on safe defaults", () => {
		// Off, because reaping removes real containers without being asked.
		expect(controllerSettings(database())).toEqual({
			reapIdleMinutes: 60,
			reapMaxAgeHours: 24,
			reapingEnabled: false,
		});
	});

	it("falls back to defaults rather than failing on an unusable stored value", () => {
		// A bad row must not take the controller down, and must not silently apply either.
		const db = database();
		db.prepare(
			"INSERT INTO controller_settings (key, value, updated_at) VALUES (?, ?, ?)",
		).run("reapIdleMinutes", "not-a-number", "2026-01-01T00:00:00Z");

		expect(controllerSettings(db).reapIdleMinutes).toBe(60);
	});
});

describe("updateControllerSettings", () => {
	it("saves a change and reads it back", () => {
		const db = database();

		const saved = updateControllerSettings(db, {
			reapIdleMinutes: 30,
			reapingEnabled: true,
		});

		expect(saved.kind).toBe("saved");
		expect(controllerSettings(db)).toEqual({
			reapIdleMinutes: 30,
			reapMaxAgeHours: 24,
			reapingEnabled: true,
		});
	});

	it("leaves settings it was not asked about alone", () => {
		const db = database();
		updateControllerSettings(db, { reapMaxAgeHours: 8 });

		updateControllerSettings(db, { reapIdleMinutes: 15 });

		expect(controllerSettings(db).reapMaxAgeHours).toBe(8);
	});

	it("refuses a value outside its bounds instead of storing it", () => {
		// These arrive from a form. An idle timeout of zero would reap a workspace the instant it
		// became ready, which is a footgun rather than a configuration.
		const db = database();

		const refused = updateControllerSettings(db, { reapIdleMinutes: 0 });

		expect(refused.kind).toBe("invalid");
		expect(controllerSettings(db).reapIdleMinutes).toBe(60);
	});

	it("cannot be talked past one field at a time", () => {
		// Validated against the whole schema on every update, so a bound is not bypassable by
		// sending settings separately.
		const db = database();
		updateControllerSettings(db, { reapingEnabled: true });

		expect(updateControllerSettings(db, { reapMaxAgeHours: 99_999 }).kind).toBe(
			"invalid",
		);
		expect(controllerSettings(db).reapMaxAgeHours).toBe(24);
	});
});

function database(): Database.Database {
	const db = openDatabase(":memory:");
	databases.push(db);

	return db;
}
