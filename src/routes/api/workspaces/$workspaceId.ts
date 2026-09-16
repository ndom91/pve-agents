import { createFileRoute } from "@tanstack/react-router";
import { requireOperator } from "../../../server/authorize";
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
				const denied = await requireOperator(request);
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
				if (
					result.kind === "invalid_transition" ||
					result.kind === "already_queued"
				) {
					return json({ error: result.message }, 409);
				}

				return json(result, 202);
			},
			GET: async ({
				params,
				request,
			}: {
				params: WorkspaceParams;
				request: Request;
			}) => {
				const denied = await requireOperator(request);
				if (denied !== undefined) {
					return denied;
				}

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
