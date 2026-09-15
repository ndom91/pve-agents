import { createFileRoute } from "@tanstack/react-router";

import { authConfigured } from "../../server/auth";
import { controllerRuntimeConfig } from "../../server/controller";
import { json } from "../../server/http";

export const Route = createFileRoute("/api/health")({
	server: {
		handlers: {
			GET: () => {
				const config = controllerRuntimeConfig();

				return json({
					// Reports only whether auth is configured. No key, secret, or hash is ever
					// exposed here.
					auth: authConfigured(config) ? "configured" : "unconfigured",
					ok: true,
					provisioning: config.provisioningEnabled ? "enabled" : "disabled",
				});
			},
		},
	},
});
