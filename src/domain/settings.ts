import { z } from "zod";

// controllerSettingsSchema is the operational policy an operator tunes while watching the
// controller run.
//
// Separate from ControllerConfig on purpose. Configuration is what this controller *is* — its
// Proxmox token, its GitHub App, where its key lives — and changing that is a deployment change.
// These are what it *does*, and they get adjusted against a running fleet, so they live in the
// database and take effect on the next pass.
//
// Every bound here is load-bearing because these arrive from a form rather than from a file. An
// idle timeout of zero would reap a workspace the instant it became ready, which is a footgun
// rather than a configuration.
export const controllerSettingsSchema = z.object({
	// Off by default. Reaping destroys real containers without being asked, so it should be
	// switched on deliberately rather than inherited from a default.
	reapingEnabled: z.boolean().default(false),
	reapIdleMinutes: z.coerce.number().int().min(5).max(10_080).default(60),
	reapMaxAgeHours: z.coerce.number().int().min(1).max(720).default(24),
});

// ControllerSettings is the validated operational policy.
export type ControllerSettings = z.output<typeof controllerSettingsSchema>;

// SETTING_KEYS is every setting name, so a stored row that no longer maps to one is ignored
// rather than carried around forever.
export const SETTING_KEYS = Object.keys(
	controllerSettingsSchema.shape,
) as (keyof ControllerSettings)[];

// defaultControllerSettings is the policy a controller that has never been configured runs under.
export function defaultControllerSettings(): ControllerSettings {
	return controllerSettingsSchema.parse({});
}

// parseControllerSettings turns stored strings back into typed policy, falling back to defaults.
//
// Values are stored as text because the table is key/value, so booleans and numbers both arrive
// as strings and have to be coerced back.
export function parseControllerSettings(
	stored: Record<string, string>,
): ControllerSettings {
	const raw: Record<string, unknown> = {};
	for (const key of SETTING_KEYS) {
		const value = stored[key];
		if (value === undefined) {
			continue;
		}

		raw[key] = value === "true" ? true : value === "false" ? false : value;
	}

	// A stored value that no longer validates must not take the controller down, and it must not
	// silently apply either. Falling back to defaults is the one option that does neither.
	const parsed = controllerSettingsSchema.safeParse(raw);

	return parsed.success ? parsed.data : defaultControllerSettings();
}

// serialiseSetting renders one setting for storage.
export function serialiseSetting(value: boolean | number): string {
	return String(value);
}
