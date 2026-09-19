import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
	checkWorkspaceRequest,
	destroyWorkspace,
	listRequestedWorkspaces,
	requestWorkspace,
	retryWorkspace,
	workspaceRequestSchema,
	workspaceWithTimeline,
} from "../services/workspace-service";
import { controllerDatabase, controllerRuntimeConfig } from "./controller";
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
	.handler(async ({ data }) => {
		const refusal = await checkWorkspaceRequest(
			controllerRuntimeConfig(),
			data,
		);
		if (refusal !== undefined) {
			throw new Error(`workspace: ${refusal.message}`);
		}

		const result = requestWorkspace(
			controllerDatabase(),
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

// workspaceDetail returns one workspace with its placement, failure detail, and whole timeline.
export const workspaceDetail = createServerFn({ method: "GET" })
	.middleware([operatorMiddleware])
	.validator(z.object({ id: z.string().trim().min(1) }))
	.handler(({ data }) => {
		const workspace = workspaceWithTimeline(controllerDatabase(), data.id);
		if (workspace === undefined) {
			throw new Error("workspace: not found");
		}

		return workspace;
	});

// retryWorkspaceRequest queues a fresh provision for a workspace that failed.
//
// The state machine allows failed -> provisioning, and the phase is deliberately not cleared, so a
// retry resumes from the step that failed rather than rebuilding from nothing.
export const retryWorkspaceRequest = createServerFn({ method: "POST" })
	.middleware([operatorMiddleware])
	.validator(z.object({ id: z.string().trim().min(1) }))
	.handler(({ data }) => {
		const result = retryWorkspace(controllerDatabase(), data.id);
		if (result.kind === "not_found") {
			throw new Error("workspace: not found");
		}
		if (result.kind !== "created") {
			throw new Error(`workspace: ${result.message}`);
		}

		return result;
	});
