import { apiKey } from "@better-auth/api-key";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import type Database from "better-sqlite3";

import type { ControllerConfig } from "../config/controller-config";
import { controllerDatabase, controllerRuntimeConfig } from "./controller";

// SERVICE_ACCOUNT_EMAIL identifies the single machine account that owns controller API keys.
//
// better-auth scopes keys to a user. This controller has no human users, so one local service
// account stands in as the owner. It has no credentials and cannot sign in.
const SERVICE_ACCOUNT_EMAIL = "controller@pve-herdr-agents.local";

// API keys guard operations that clone and purge real containers, so the allowance is generous
// enough for an operator driving the CLI but far from unlimited.
const RATE_LIMIT_MAX_REQUESTS = 600;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

// ControllerAuth is the configured better-auth instance.
export type ControllerAuth = ReturnType<typeof createControllerAuth>;

// createControllerAuth builds a better-auth instance over an existing controller database.
//
// Sharing the controller's own better-sqlite3 handle keeps auth state in the same file, and the
// same backup, as workspace state.
export function createControllerAuth(
	db: Database.Database,
	config: ControllerConfig,
) {
	return betterAuth({
		baseURL: config.CONTROLLER_URL,
		database: db,
		plugins: [
			apiKey({
				apiKeyHeaders: ["x-api-key"],
				rateLimit: {
					enabled: true,
					maxRequests: RATE_LIMIT_MAX_REQUESTS,
					timeWindow: RATE_LIMIT_WINDOW_MS,
				},
			}),
		],
		secret: config.CONTROLLER_AUTH_SECRET as string,
	});
}

// migrateControllerAuth applies better-auth's own schema to the controller database.
//
// Running this in-process keeps deployment to one migration step. better-auth owns its tables and
// the controller owns its own, so the two migration systems never touch the same objects.
export async function migrateControllerAuth(
	db: Database.Database,
	config: ControllerConfig,
): Promise<void> {
	const { runMigrations } = await getMigrations({
		baseURL: config.CONTROLLER_URL,
		database: db,
		plugins: [apiKey()],
		secret: config.CONTROLLER_AUTH_SECRET as string,
	});

	await runMigrations();
}

// issueControllerApiKey mints one API key owned by the service account.
//
// The returned plaintext key is the only copy; better-auth stores a hash and no endpoint can read
// it back.
export async function issueControllerApiKey(
	auth: ControllerAuth,
	name: string,
): Promise<string> {
	const context = await auth.$context;
	const existing = await context.internalAdapter.findUserByEmail(
		SERVICE_ACCOUNT_EMAIL,
	);
	const userId =
		existing?.user.id ??
		(
			await context.internalAdapter.createUser(
				{
					email: SERVICE_ACCOUNT_EMAIL,
					emailVerified: true,
					name: "pve-herdr-agents controller",
				},
				// "admin" marks this as an operator-provisioned account. No credential provider is
				// enabled, so the row exists purely to own API keys and can never sign in.
				{ method: "admin" },
			)
		).id;

	const created = await auth.api.createApiKey({ body: { name, userId } });
	if (typeof created.key !== "string") {
		throw new Error("better-auth did not return an API key");
	}

	return created.key;
}

let instance: Promise<ControllerAuth> | undefined;

// controllerAuth returns the process-local better-auth instance with its schema applied.
//
// Migrating here rather than in a deploy script keeps deployment to one step and means a fresh
// database is usable immediately. runMigrations only creates what is missing, and the promise is
// memoised, so repeated calls cost nothing.
export function controllerAuth(): Promise<ControllerAuth> {
	if (instance === undefined) {
		instance = (async () => {
			const db = controllerDatabase();
			const config = controllerRuntimeConfig();
			await migrateControllerAuth(db, config);

			return createControllerAuth(db, config);
		})();
	}

	return instance;
}

// authConfigured reports whether the controller has an auth secret to verify keys with.
export function authConfigured(config: ControllerConfig): boolean {
	return config.CONTROLLER_AUTH_SECRET !== undefined;
}
