import { getRequestHeaders } from "@tanstack/react-start/server";

import { authConfigured, controllerAuth } from "./auth";
import { controllerRuntimeConfig } from "./controller";

// OperatorSession is the signed-in operator, or null when the request carries no session.
export type OperatorSession = Awaited<
	ReturnType<Awaited<ReturnType<typeof controllerAuth>>["api"]["getSession"]>
>;

// currentSession returns the operator session for the request in flight.
export async function currentSession(): Promise<OperatorSession> {
	if (!authConfigured(controllerRuntimeConfig())) {
		return null;
	}

	const auth = await controllerAuth();

	return auth.api.getSession({ headers: getRequestHeaders() });
}

// requireSession returns the operator session, refusing to continue without one.
//
// An unconfigured controller has no secret to verify against and is allowed through. That state
// cannot reach real infrastructure: configuration validation refuses PROVISIONING_ENABLED=true
// without CONTROLLER_AUTH_SECRET.
export async function requireSession(): Promise<OperatorSession> {
	const session = await currentSession();
	if (session === null && authConfigured(controllerRuntimeConfig())) {
		throw new Error("Unauthorized");
	}

	return session;
}
