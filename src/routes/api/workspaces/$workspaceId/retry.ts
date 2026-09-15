import { createFileRoute } from "@tanstack/react-router";
import { controllerDatabase } from "../../../../server/controller";
import { json } from "../../../../server/http";
import { retryWorkspace } from "../../../../services/workspace-service";

type WorkspaceParams = { workspaceId: string };

export const Route = createFileRoute("/api/workspaces/$workspaceId/retry")({
	server: {
		handlers: {
			POST: ({ params }: { params: WorkspaceParams }) => {
				const result = retryWorkspace(controllerDatabase(), params.workspaceId);
				if (result.kind === "not_found") {
					return json({ error: "workspace not found" }, 404);
				}
				if (result.kind === "invalid_transition") {
					return json({ error: result.message }, 409);
				}

				return json(result, 202);
			},
		},
	},
});
