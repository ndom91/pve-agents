import { controllerConfig } from "../config/controller-config";
import { openDatabase } from "../db/database";

let database: ReturnType<typeof openDatabase> | undefined;

// controllerDatabase returns the process-local controller database.
export function controllerDatabase() {
	if (database === undefined) {
		const config = controllerConfig(process.env);

		database = openDatabase(config.DATABASE_PATH);
	}

	return database;
}

// controllerHerdrSession returns the configured remote workspace Herdr session name.
export function controllerHerdrSession() {
	const config = controllerConfig(process.env);

	return config.WORKSPACE_HERDR_SESSION;
}
