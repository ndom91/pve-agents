import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { requireOperator } from "../../server/authorize";
import {
	controllerDatabase,
	controllerHerdrSession,
	controllerRuntimeConfig,
} from "../../server/controller";
import { invalidJson, json } from "../../server/http";
import {
	checkWorkspaceRequest,
	listRequestedWorkspaces,
	requestWorkspace,
	workspaceRequestSchema,
} from "../../services/workspace-service";

const createWorkspaceInput = workspaceRequestSchema.extend({
	idempotencyKey: z.string().trim().min(1).max(255),
});

export const Route = createFileRoute("/api/workspaces")({
	server: {
		handlers: {
			GET: async ({ request }: { request: Request }) => {
				const denied = await requireOperator(request);
				if (denied !== undefined) {
					return denied;
				}

				return json({
					workspaces: listRequestedWorkspaces(controllerDatabase()),
				});
			},
			POST: async ({ request }: { request: Request }) => {
				const denied = await requireOperator(request);
				if (denied !== undefined) {
					return denied;
				}

				const body = await requestBody(request);
				if (body === undefined) {
					return invalidJson();
				}

				const input = createWorkspaceInput.safeParse(body);
				if (!input.success) {
					return json({ error: "invalid workspace request" }, 400);
				}

				const refusal = await checkWorkspaceRequest(
					controllerRuntimeConfig(),
					input.data,
				);
				if (refusal !== undefined) {
					return json({ error: refusal.message }, 400);
				}

				const result = requestWorkspace(
					controllerDatabase(),
					controllerHerdrSession(),
					input.data.idempotencyKey,
					input.data,
				);
				if (result.kind === "idempotency_conflict") {
					return json(
						{
							error:
								"idempotency key has already been used for another request",
						},
						409,
					);
				}

				return json(result, result.kind === "created" ? 201 : 200);
			},
		},
	},
});

async function requestBody(request: Request): Promise<unknown | undefined> {
	try {
		return await request.json();
	} catch {
		return undefined;
	}
}
