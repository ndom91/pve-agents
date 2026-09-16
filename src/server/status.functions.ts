import { createServerFn } from "@tanstack/react-start";

import { countActiveOperations } from "../db/workspace-repository";
import { controllerDatabase, controllerRuntimeConfig } from "./controller";
import { operatorMiddleware } from "./middleware";

// ControllerStatus is the operational state the fleet view reports.
export type ControllerStatus = {
	// Operations the worker still has to act on. The fleet view refreshes while this is above
	// zero and stops when it reaches zero, so a settled page does no polling at all.
	activeOperations: number;
	provisioningEnabled: boolean;
	workerEnabled: boolean;
};

// controllerStatus reports whether this controller acts on queued work.
//
// Both flags matter to an operator and mean different things: provisioning enabled but the worker
// off is a controller that accepts requests and advances them only when told to.
export const controllerStatus = createServerFn({ method: "GET" })
	.middleware([operatorMiddleware])
	.handler((): ControllerStatus => {
		const config = controllerRuntimeConfig();

		return {
			activeOperations: countActiveOperations(controllerDatabase()),
			provisioningEnabled: config.provisioningEnabled,
			workerEnabled: config.workerEnabled,
		};
	});
