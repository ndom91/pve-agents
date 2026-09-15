import { createFileRoute } from "@tanstack/react-router";
import { requireApiKey } from "../../../server/authorize";
import { controllerDatabase } from "../../../server/controller";
import { json } from "../../../server/http";
import {
	destroyWorkspace,
	requestedWorkspace,
} from "../../../services/workspace-service";

type WorkspaceParams = { workspaceId: string };

export const Route = createFileRoute("/api/workspaces/$workspaceId")({
	server: {
		handlers: {
			DELETE: async ({
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

				const result = destroyWorkspace(
					controllerDatabase(),
					params.workspaceId,
				);
				if (result.kind === "not_found") {
					return json({ error: "workspace not found" }, 404);
				}
				if (result.kind === "invalid_transition") {
					return json({ error: result.message }, 409);
				}

				return json(result, 202);
			},
			GET: ({ params }: { params: WorkspaceParams }) => {
				const workspace = requestedWorkspace(
					controllerDatabase(),
					params.workspaceId,
				);
				if (workspace === undefined) {
					return json({ error: "workspace not found" }, 404);
				}

				return json({ workspace });
			},
		},
	},
});
