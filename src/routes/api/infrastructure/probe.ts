import { createFileRoute } from "@tanstack/react-router";
import { requireOperator } from "../../../server/authorize";
import { controllerRuntimeConfig } from "../../../server/controller";
import { json } from "../../../server/http";
import { probeProxmox } from "../../../services/proxmox-probe";

export const Route = createFileRoute("/api/infrastructure/probe")({
	server: {
		handlers: {
			// The probe reveals node, pool, storage, and template names. No secrets, but it is a
			// map of the infrastructure and does not belong on an open endpoint.
			GET: async ({ request }: { request: Request }) => {
				const denied = await requireOperator(request);
				if (denied !== undefined) {
					return denied;
				}

				return json(await probeProxmox(controllerRuntimeConfig()));
			},
		},
	},
});
