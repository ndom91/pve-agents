import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
	listRequestedWorkspaces,
	requestWorkspace,
} from "../services/workspace-service";
import { controllerDatabase, controllerHerdrSession } from "./controller";

const createWorkspaceInput = z.object({
	idempotencyKey: z.string().trim().min(1).max(255),
	purpose: z.string().trim().min(1).max(500).optional(),
	repository: z.string().trim().min(1).max(2_000),
	ref: z.string().trim().min(1).max(255).default("main"),
});

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
		if (!result.ok) {
			throw new Error(
				`workspace: invalid request: ${result.issues.join(", ")}`,
			);
		}

		if (result.result.kind === "idempotency_conflict") {
			throw new Error(
				"workspace: idempotency key has already been used for another request",
			);
		}

		return result.result;
	});

// listWorkspaces returns persisted workspace requests.
export const listWorkspaces = createServerFn({ method: "GET" }).handler(() => {
	return listRequestedWorkspaces(controllerDatabase());
});
