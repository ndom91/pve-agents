import { migrateControllerAuth } from "../server/auth";
import {
	controllerDatabase,
	controllerRuntimeConfig,
} from "../server/controller";

// Two migration systems share this database: the controller's own versioned runner and
// better-auth's, which owns the user, session, account, verification, and apikey tables. Both are
// idempotent, and a deploy needs both, so running one without the other is never right.
async function main(): Promise<void> {
	const config = controllerRuntimeConfig();
	const db = controllerDatabase();

	// openDatabase applies the controller's migrations, so this is already done by the line above.
	const version = db
		.prepare("SELECT max(version) AS version FROM schema_migrations")
		.get() as { version: number };
	console.log(`controller schema at version ${version.version}`);

	if (config.CONTROLLER_AUTH_SECRET === undefined) {
		console.log(
			"better-auth schema skipped: CONTROLLER_AUTH_SECRET is not set",
		);

		return;
	}

	await migrateControllerAuth(db, config);
	console.log("better-auth schema applied");
}

main().catch((error) => {
	console.error("migration failed", error);
	process.exitCode = 1;
});
