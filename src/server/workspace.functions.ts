import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
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

// listWorkspaces returns persisted workspace requests.
export const listWorkspaces = createServerFn({ method: "GET" })
	.middleware([operatorMiddleware])
	.handler(() => {
		return listRequestedWorkspaces(controllerDatabase());
	});
