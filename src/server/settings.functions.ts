import { createServerFn } from "@tanstack/react-start";
import {
	controllerSettings,
	updateControllerSettings,
} from "../db/settings-repository";
import { controllerSettingsSchema } from "../domain/settings";
import { controllerDatabase } from "./controller";
import { operatorMiddleware } from "./middleware";

// workspaceSettings returns the operational policy the controller is running under.
export const workspaceSettings = createServerFn({ method: "GET" })
	.middleware([operatorMiddleware])
	.handler(() => controllerSettings(controllerDatabase()));

// saveWorkspaceSettings updates the policy, taking effect on the next pass.
//
// No restart: these are read from the database on every pass, which is the reason they live there
// rather than in the environment.
export const saveWorkspaceSettings = createServerFn({ method: "POST" })
	.middleware([operatorMiddleware])
	.validator(controllerSettingsSchema.partial())
	.handler(({ data }) => {
		const saved = updateControllerSettings(controllerDatabase(), data);
		if (saved.kind === "invalid") {
			throw new Error(`settings: ${saved.message}`);
		}

		return saved.settings;
	});
