import { createFileRoute } from "@tanstack/react-router";
import { requireApiKey } from "../../../../server/authorize";
import { controllerDatabase } from "../../../../server/controller";
import { json } from "../../../../server/http";
import { retryWorkspace } from "../../../../services/workspace-service";

type WorkspaceParams = { workspaceId: string };

export const Route = createFileRoute("/api/workspaces/$workspaceId/retry")({
	server: {
		handlers: {
			POST: async ({
				params,
				request,
			}: {
				params: WorkspaceParams;
				request: Request;
			}) => {
				const denied = await requireApiKey(request);
				if (denied !== undefined) {
					return denied;
				}

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
