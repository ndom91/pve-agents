import { createServerFn } from "@tanstack/react-start";

import { controllerRuntimeConfig } from "./controller";
import { operatorMiddleware } from "./middleware";

// ControllerStatus is the operational state the fleet view reports.
export type ControllerStatus = {
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
			provisioningEnabled: config.provisioningEnabled,
			workerEnabled: config.workerEnabled,
		};
	});
