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
		// Thrown as a Response, not an Error: a generic Error surfaces to the browser as a 500,
		// which is indistinguishable from the controller being broken. The HTTP routes answer 401
		// for the same denial, and a session that expires between page load and submit should look
		// the same either way.
		throw new Response(JSON.stringify({ error: "unauthorized" }), {
			headers: { "content-type": "application/json" },
			status: 401,
		});
	}

	return session;
}
