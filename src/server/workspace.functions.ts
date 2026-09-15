import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
	listRequestedWorkspaces,
	requestWorkspace,
	workspaceRequestSchema,
} from "../services/workspace-service";
import { controllerDatabase, controllerHerdrSession } from "./controller";

const createWorkspaceInput = z
	.object({
		idempotencyKey: z.string().trim().min(1).max(255),
	})
	.extend(workspaceRequestSchema.shape);

// createWorkspace creates one durable workspace request.
export const createWorkspace = createServerFn({ method: "POST" })
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
export const listWorkspaces = createServerFn({ method: "GET" }).handler(() => {
	return listRequestedWorkspaces(controllerDatabase());
});
