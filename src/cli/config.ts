import { controllerRuntimeConfig } from "../server/controller";

// StartupConfig is the subset of validated configuration the process bootstrap needs.
export type StartupConfig = {
	workerEnabled: boolean;
};

// validateStartupConfig parses configuration before the listener opens.
//
// controllerRuntimeConfig is otherwise parsed lazily on the first request, so a misconfigured
// controller used to start, report itself active, and then fail every request with a 500. Calling
// it here turns that into a refusal to start, which is what the runbook has always claimed.
export function validateStartupConfig(): StartupConfig {
	return { workerEnabled: controllerRuntimeConfig().workerEnabled };
}
