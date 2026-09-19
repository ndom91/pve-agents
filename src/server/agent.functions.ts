import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import {
	answerApproval,
	discardWorkspaceWork,
	pushWorkspaceWork,
	readWorkspaceChanges,
	readWorkspaceFile,
	sendAgentPrompt,
} from "./agent-operations";
import { operatorMiddleware } from "./middleware";

export type { AgentInput } from "./agent-operations";

// Every server function here is a wrapper: validate, guard, and call an operation from
// agent-operations.ts, which is where the work and the tests live.
//
// The operations are in their own module rather than this one, and that is load-bearing rather
// than tidy. Exporting them from here as well built a client bundle in which this route silently
// failed to hydrate: the page rendered from the server and then sat inert, no console error, no
// failed request, every button dead. Anything exported beside a server function has to survive the
// plugin's client transform, and these cannot.
//
// So: handlers stay one line, and nothing else is exported from this file. If a change here ever
// grows past that, open the site and click something before believing it works.

// promptWorkspaceAgent submits an operator's prompt to a workspace's agent.
export const promptWorkspaceAgent = createServerFn({ method: "POST" })
	.middleware([operatorMiddleware])
	.validator(
		z.object({
			id: z.string().trim().min(1),
			text: z.string().trim().min(1).max(10_000),
		}),
	)
	.handler(({ data }) => sendAgentPrompt(data.id, data.text));

// answerWorkspaceApproval allows or denies one tool call the agent is suspended on.
//
// The decision this whole control plane exists to make. It names the request rather than aiming a
// keystroke at a dialog, so the answer cannot land on the wrong call or on no call at all.
export const answerWorkspaceApproval = createServerFn({ method: "POST" })
	.middleware([operatorMiddleware])
	.validator(
		z.object({
			approvalId: z.string().trim().min(1).max(64),
			behavior: z.enum(["allow", "deny"]),
			id: z.string().trim().min(1),
		}),
	)
	.handler(({ data }) =>
		answerApproval(data.id, data.approvalId, data.behavior),
	);

// workspaceChanges lists what the agent has done to the checkout.
//
// Available whenever a workspace is ready rather than only once the reaper has flagged it. The work
// is the point of the workspace, and waiting for a protection to trip before showing it would mean
// the only way to see finished work is for something to have gone slightly wrong.
export const workspaceChanges = createServerFn({ method: "GET" })
	.middleware([operatorMiddleware])
	.validator(z.object({ id: z.string().trim().min(1) }))
	.handler(({ data }) => readWorkspaceChanges(data.id));

// workspaceFileDiff reads one file as it was and as it is.
export const workspaceFileDiff = createServerFn({ method: "GET" })
	.middleware([operatorMiddleware])
	.validator(
		z.object({
			id: z.string().trim().min(1),
			path: z.string().trim().min(1).max(1_024),
		}),
	)
	.handler(({ data }) => readWorkspaceFile(data.id, data.path));

// pushWorkspaceChanges saves everything in the workspace onto a branch of its own.
export const pushWorkspaceChanges = createServerFn({ method: "POST" })
	.middleware([operatorMiddleware])
	.validator(
		z.object({
			id: z.string().trim().min(1),
			message: z.string().trim().min(1).max(500),
		}),
	)
	.handler(({ data }) => pushWorkspaceWork(data.id, data.message));

// discardWorkspaceChanges throws the working tree away.
//
// The only operator action here that destroys something, and it destroys exactly what the reaper
// refuses to. It stays because the alternative is worse: without it a workspace held by one stray
// scratch file can only be released by opening a terminal, which is the gap this whole view exists
// to close. The confirmation naming the file count lives in the UI; a generic "are you sure" is one
// people learn to dismiss.
export const discardWorkspaceChanges = createServerFn({ method: "POST" })
	.middleware([operatorMiddleware])
	.validator(z.object({ id: z.string().trim().min(1) }))
	.handler(({ data }) => discardWorkspaceWork(data.id));
