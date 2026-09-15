import {
	controllerDatabase,
	controllerRuntimeConfig,
} from "../server/controller";
import { startWorkspaceScheduler } from "../services/workspace-scheduler";

// startScheduler runs the operation loop inside the controller server process.
//
// Exported for bin/controller-server.mjs, which imports it only when WORKER_ENABLED=true so that
// an unscheduled controller never loads it at all.
export function startScheduler(signal: AbortSignal): Promise<void> {
	const config = controllerRuntimeConfig();

	console.log(
		`scheduler running every ${config.WORKER_INTERVAL_SECONDS}s (provisioning ${
			config.provisioningEnabled ? "enabled" : "disabled"
		})`,
	);

	return startWorkspaceScheduler(controllerDatabase(), config, signal, {
		onError: (error) => console.error("scheduler tick failed", error),
	});
}
