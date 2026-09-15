import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
	listRequestedWorkspaces,
	requestWorkspace,
	workspaceRequestSchema,
} from "../services/workspace-service";
import { authConfigured } from "./auth";
import {
	controllerDatabase,
	controllerHerdrSession,
	controllerRuntimeConfig,
} from "./controller";

const createWorkspaceInput = z
	.object({
		idempotencyKey: z.string().trim().min(1).max(255),
	})
	.extend(workspaceRequestSchema.shape);

// createWorkspace creates one durable workspace request.
export const createWorkspace = createServerFn({ method: "POST" })
	.validator(createWorkspaceInput)
	.handler(({ data }) => {
		// Server functions are reachable over HTTP but carry no API key, and shipping one to the
		// browser would simply publish it. So once auth is configured the UI is read-only and all
		// mutations go through the key-authenticated HTTP API instead.
		if (authConfigured(controllerRuntimeConfig())) {
			throw new Error(
				"workspace: creation from the web UI is disabled; use POST /api/workspaces with an API key",
			);
		}

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
