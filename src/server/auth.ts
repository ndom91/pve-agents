import { apiKey } from "@better-auth/api-key";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import type Database from "better-sqlite3";

import type { ControllerConfig } from "../config/controller-config";
import { controllerDatabase, controllerRuntimeConfig } from "./controller";

// SERVICE_ACCOUNT_EMAIL identifies the single machine account that owns controller API keys.
//
// better-auth scopes keys to a user. This controller has no human users, so one local service
// account stands in as the owner. It has no credentials and cannot sign in.
const SERVICE_ACCOUNT_EMAIL = "controller@pve-agents.local";

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
			// Must stay last: it observes the final response after every other plugin has
			// contributed to it, and writes cookies through TanStack Start.
			tanstackStartCookies(),
		],
		secret: config.CONTROLLER_AUTH_SECRET as string,
		socialProviders: {
			github: {
				clientId: config.GITHUB_CLIENT_ID as string,
				clientSecret: config.GITHUB_CLIENT_SECRET as string,
			},
		},
		user: { validateUserInfo: operatorGate(config) },
	});
}

// operatorGate restricts the controller to exactly one GitHub account.
//
// This is the security boundary for the web UI. better-auth runs the hook for "create-user",
// "link-account", and "sign-in" alike, so one gate closes every path by which an account could
// appear. Because no second user can ever be created, the controller cannot quietly grow a second
// operator.
export function operatorGate(config: ControllerConfig) {
	return ({
		source,
	}: {
		source: { action: string; oauth?: { profile?: Record<string, unknown> } };
	}): { error: string } | undefined => {
		// Matched on the immutable numeric account id. A GitHub login can be released and claimed
		// by someone else, so matching on it would be a real, if unlikely, takeover path.
		const id = source.oauth?.profile?.id;
		if (id === undefined || id === null) {
			return { error: "github_profile_missing_id" };
		}
		if (String(id) !== config.CONTROLLER_OPERATOR_GITHUB_ID) {
			return { error: "not_the_controller_operator" };
		}

		return undefined;
	};
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

	let userId = existing?.user.id;
	if (userId === undefined) {
		// Written through the adapter rather than internalAdapter.createUser deliberately. The
		// latter runs the operator allow-list, which needs an HTTP endpoint context it cannot have
		// here, and which exists to vet GitHub sign-ins. This row is controller-owned, has no
		// linked account, and can never sign in.
		const now = new Date();
		const created = (await context.adapter.create({
			data: {
				createdAt: now,
				email: SERVICE_ACCOUNT_EMAIL,
				emailVerified: true,
				name: "pve-agents controller",
				updatedAt: now,
			},
			model: "user",
		})) as { id: string };

		userId = created.id;
	}

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
