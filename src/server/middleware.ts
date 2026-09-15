import { createMiddleware } from "@tanstack/react-start";

import { requireSession } from "./session";

// operatorMiddleware requires a signed-in operator before a server function runs.
//
// better-auth's own guidance is to call a session helper by hand at the top of every handler,
// which is one forgotten line away from an unguarded mutation. Attaching middleware makes the
// guard structural instead, and hands the session to the handler through context so it is not
// fetched twice.
export const operatorMiddleware = createMiddleware({ type: "function" }).server(
	async ({ next }) => next({ context: { session: await requireSession() } }),
);
