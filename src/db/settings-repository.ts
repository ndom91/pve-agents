import type Database from "better-sqlite3";

import {
	type ControllerSettings,
	controllerSettingsSchema,
	parseControllerSettings,
	SETTING_KEYS,
	serialiseSetting,
} from "../domain/settings";

// UpdateSettingsResult separates a saved change from one that was refused.
export type UpdateSettingsResult =
	| { kind: "invalid"; message: string }
	| { kind: "saved"; settings: ControllerSettings };

// controllerSettings reads the current operational policy.
//
// Read on every use rather than memoised, unlike ControllerConfig. That is the whole reason these
// live in the database: a change takes effect on the next pass, with no restart, so thresholds can
// be tuned against a running fleet instead of by editing a file over SSH.
//
// No lease, like the other writes about settled state in this codebase. Policy is not operation
// work: there is nothing to resume and no exclusivity to protect.
export function controllerSettings(db: Database.Database): ControllerSettings {
	const rows = db
		.prepare("SELECT key, value FROM controller_settings")
		.all() as { key: string; value: string }[];
	const stored: Record<string, string> = {};
	for (const row of rows) {
		stored[row.key] = row.value;
	}

	return parseControllerSettings(stored);
}

// updateControllerSettings saves a partial change, leaving anything it does not mention alone.
//
// Validated against the whole schema rather than per field, so a bound can never be bypassed by
// sending one setting at a time.
export function updateControllerSettings(
	db: Database.Database,
	patch: Partial<Record<keyof ControllerSettings, unknown>>,
	now: Date = new Date(),
): UpdateSettingsResult {
	const merged = controllerSettingsSchema.safeParse({
		...controllerSettings(db),
		...patch,
	});
	if (!merged.success) {
		return {
			kind: "invalid",
			message: merged.error.issues
				.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
				.join("; "),
		};
	}

	const nowText = now.toISOString();
	const save = db.transaction(() => {
		for (const key of SETTING_KEYS) {
			db.prepare(
				`INSERT INTO controller_settings (key, value, updated_at) VALUES (?, ?, ?)
				 ON CONFLICT(key) DO UPDATE SET value = excluded.value,
					updated_at = excluded.updated_at`,
			).run(key, serialiseSetting(merged.data[key]), nowText);
		}
	});
	save();

	return { kind: "saved", settings: merged.data };
}
