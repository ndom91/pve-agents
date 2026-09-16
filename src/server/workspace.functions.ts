import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
	destroyWorkspace,
	listRequestedWorkspaces,
	requestWorkspace,
	workspaceRequestSchema,
} from "../services/workspace-service";
import { controllerDatabase, controllerHerdrSession } from "./controller";
import { operatorMiddleware } from "./middleware";

const createWorkspaceInput = z
	.object({
		idempotencyKey: z.string().trim().min(1).max(255),
	})
	.extend(workspaceRequestSchema.shape);

// createWorkspace creates one durable workspace request.
export const createWorkspace = createServerFn({ method: "POST" })
	.middleware([operatorMiddleware])
	.validator(createWorkspaceInput)
	.handler(({ data }) => {
		const result = requestWorkspace(
			controllerDatabase(),
			controllerHerdrSession(),
			data.idempotencyKey,
			data,
		);
		if (result.kind === "idempotency_conflict") {
			throw new Error(
				"workspace: idempotency key has already been used for another request",
			);
		}

		return result;
	});

// destroyWorkspaceRequest queues teardown for one workspace.
export const destroyWorkspaceRequest = createServerFn({ method: "POST" })
	.middleware([operatorMiddleware])
	.validator(z.object({ id: z.string().trim().min(1) }))
	.handler(({ data }) => {
		const result = destroyWorkspace(controllerDatabase(), data.id);
		if (result.kind === "not_found") {
			throw new Error("workspace: not found");
		}
		if (result.kind !== "created") {
			throw new Error(`workspace: ${result.message}`);
		}

		return result;
	});

// listWorkspaces returns persisted workspace requests.
export const listWorkspaces = createServerFn({ method: "GET" })
	.middleware([operatorMiddleware])
	.handler(() => {
		return listRequestedWorkspaces(controllerDatabase());
	});
