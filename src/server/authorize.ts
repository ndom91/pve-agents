import type { ControllerConfig } from "../config/controller-config";
import { authConfigured, type ControllerAuth, controllerAuth } from "./auth";
import { controllerRuntimeConfig } from "./controller";
import { json } from "./http";

// requireApiKey guards one mutating route, returning a 401 response when the caller may not act.
//
// Returns undefined when the request may proceed, so a handler reads as an early return rather
// than a nested conditional that is easy to drop during a later edit.
export async function requireApiKey(
	request: Request,
): Promise<Response | undefined> {
	const config = controllerRuntimeConfig();
	if (!authConfigured(config)) {
		return undefined;
	}

	const result = await authorizeRequest(
		request,
		config,
		await controllerAuth(),
	);
	if (result.kind === "unauthorized") {
		return json({ error: "unauthorized" }, 401);
	}

	return undefined;
}

// AuthorizationResult is the verdict on one incoming mutating request.
export type AuthorizationResult =
	| { kind: "authorized" }
	| { kind: "unauthorized" };

// authorizeRequest verifies the API key presented by a mutating request.
//
// The key value is never logged and never echoed back: a 401 says nothing about which part of the
// credential was wrong, so a caller cannot probe for valid prefixes.
export async function authorizeRequest(
	request: Request,
	config: ControllerConfig,
	auth: ControllerAuth,
): Promise<AuthorizationResult> {
	if (!authConfigured(config)) {
		// Without a configured secret there is nothing to verify against. Mutations stay open only
		// while provisioning is disabled; configuration validation refuses to enable provisioning
		// without a secret, so this branch can never gate a real container operation.
		return { kind: "authorized" };
	}

	const key = request.headers.get("x-api-key");
	if (key === null || key.length === 0) {
		return { kind: "unauthorized" };
	}

	let verified: Awaited<ReturnType<ControllerAuth["api"]["verifyApiKey"]>>;
	try {
		verified = await auth.api.verifyApiKey({ body: { key } });
	} catch {
		return { kind: "unauthorized" };
	}
	if (!verified.valid) {
		return { kind: "unauthorized" };
	}

	return { kind: "authorized" };
}
