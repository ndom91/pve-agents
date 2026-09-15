import { controllerConfig } from "../config/controller-config";
import { openDatabase } from "../db/database";

let database: ReturnType<typeof openDatabase> | undefined;
let runtimeConfig: ReturnType<typeof controllerConfig> | undefined;

// controllerRuntimeConfig returns the validated process configuration.
export function controllerRuntimeConfig() {
	if (runtimeConfig === undefined) {
		runtimeConfig = controllerConfig(process.env);
	}

	return runtimeConfig;
}

// controllerDatabase returns the process-local controller database.
export function controllerDatabase() {
	if (database === undefined) {
		database = openDatabase(controllerRuntimeConfig().DATABASE_PATH);
	}

	return database;
}

// controllerHerdrSession returns the configured remote workspace Herdr session name.
export function controllerHerdrSession() {
	return controllerRuntimeConfig().WORKSPACE_HERDR_SESSION;
}
