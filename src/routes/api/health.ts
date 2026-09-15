import { createFileRoute } from "@tanstack/react-router";

import { controllerRuntimeConfig } from "../../server/controller";
import { json } from "../../server/http";

export const Route = createFileRoute("/api/health")({
	server: {
		handlers: {
			GET: () =>
				json({
					ok: true,
					provisioning: controllerRuntimeConfig().provisioningEnabled
						? "adapter_unavailable"
						: "disabled",
				}),
		},
	},
});
