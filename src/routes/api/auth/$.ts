import { createFileRoute } from "@tanstack/react-router";

import { controllerAuth } from "../../../server/auth";

export const Route = createFileRoute("/api/auth/$")({
	server: {
		handlers: {
			GET: async ({ request }: { request: Request }) =>
				(await controllerAuth()).handler(request),
			POST: async ({ request }: { request: Request }) =>
				(await controllerAuth()).handler(request),
		},
	},
});
