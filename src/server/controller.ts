import { controllerConfig } from "../config/controller-config";
import { openDatabase } from "../db/database";

// Held on globalThis rather than in module scope because the server and the scheduler are built
// as separate bundles. Module state is per-bundle, so a plain `let` gave one process two SQLite
// connections and two parsed configurations. globalThis is the only scope both bundles share.
const STATE = Symbol.for("pve-herdr-agents.controller");

type ControllerState = {
	database?: ReturnType<typeof openDatabase>;
	runtimeConfig?: ReturnType<typeof controllerConfig>;
};

function state(): ControllerState {
	const host = globalThis as typeof globalThis & {
		[STATE]?: ControllerState;
	};
	if (host[STATE] === undefined) {
		host[STATE] = {};
	}

	return host[STATE];
}

// controllerRuntimeConfig returns the validated process configuration.
export function controllerRuntimeConfig() {
	const current = state();
	if (current.runtimeConfig === undefined) {
		current.runtimeConfig = controllerConfig(process.env);
	}

	return current.runtimeConfig;
}

// controllerDatabase returns the process-local controller database.
export function controllerDatabase() {
	const current = state();
	if (current.database === undefined) {
		current.database = openDatabase(controllerRuntimeConfig().DATABASE_PATH);
	}

	return current.database;
}

// controllerHerdrSession returns the configured remote workspace Herdr session name.
export function controllerHerdrSession() {
	return controllerRuntimeConfig().WORKSPACE_HERDR_SESSION;
}
