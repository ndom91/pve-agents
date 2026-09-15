import { createFileRoute } from "@tanstack/react-router";
import { controllerRuntimeConfig } from "../../../server/controller";
import { json } from "../../../server/http";
import { probeProxmox } from "../../../services/proxmox-probe";

export const Route = createFileRoute("/api/infrastructure/probe")({
	server: {
		handlers: {
			GET: async () => json(await probeProxmox(controllerRuntimeConfig())),
		},
	},
});
