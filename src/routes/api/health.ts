import { createFileRoute } from "@tanstack/react-router";

import { json } from "../../server/http";

export const Route = createFileRoute("/api/health")({
	server: {
		handlers: {
			GET: () => json({ ok: true, provisioning: "disabled" }),
		},
	},
});
