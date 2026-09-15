import { createServerFn } from "@tanstack/react-start";

import { authConfigured } from "./auth";
import { controllerRuntimeConfig } from "./controller";
import { currentSession } from "./session";

// SessionState is what a route guard needs to decide whether to redirect.
//
// It deliberately carries no user detail. A route only has to know whether sign-in is required on
// this controller and whether the caller has satisfied it.
export type SessionState = {
	required: boolean;
	signedIn: boolean;
};

// sessionState reports whether the current request is signed in.
export const sessionState = createServerFn({ method: "GET" }).handler(
	async (): Promise<SessionState> => {
		const required = authConfigured(controllerRuntimeConfig());
		if (!required) {
			return { required: false, signedIn: false };
		}

		return { required: true, signedIn: (await currentSession()) !== null };
	},
);
