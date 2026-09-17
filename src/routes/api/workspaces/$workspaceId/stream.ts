import { createFileRoute } from "@tanstack/react-router";

import { workspaceDetail } from "../../../../db/workspace-repository";
import { requireOperator } from "../../../../server/authorize";
import {
	controllerDatabase,
	controllerRuntimeConfig,
} from "../../../../server/controller";
import { herdrAgentName } from "../../../../services/herdr";
import {
	type WorkspaceSnapshot,
	watchWorkspace,
} from "../../../../services/workspace-watcher";

type WorkspaceParams = { workspaceId: string };

// KEEPALIVE_MS keeps an idle stream from being closed by something in the middle.
//
// A quiet agent sends nothing for minutes at a time, which a proxy or a browser will eventually
// treat as a dead connection. A comment line costs two bytes and is ignored by EventSource.
const KEEPALIVE_MS = 20_000;

// The agent stream pushes a workspace's screen and activity as they change.
//
// Server-sent events rather than a socket: everything the operator sends is request-and-answer and
// already works as a server function, so only this direction needs a stream. That keeps the
// existing operator guard, needs no upgrade handling, and gets reconnection from EventSource.
export const Route = createFileRoute("/api/workspaces/$workspaceId/stream")({
	server: {
		handlers: {
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

				const config = controllerRuntimeConfig();
				const workspace = workspaceDetail(
					controllerDatabase(),
					params.workspaceId,
				);
				const agent =
					workspace === undefined
						? undefined
						: herdrAgentName(workspace.hostname);
				const keyPath = config.WORKSPACE_SSH_KEY_PATH;

				// Refused rather than streamed as empty, so a caller can tell "nothing to watch"
				// from "watching, and quiet".
				if (
					workspace === undefined ||
					workspace.status !== "ready" ||
					workspace.ip === undefined ||
					agent === undefined ||
					keyPath === undefined
				) {
					return new Response("workspace is not watchable", { status: 409 });
				}

				const target = {
					session: config.WORKSPACE_HERDR_SESSION,
					ssh: {
						address: workspace.ip,
						keyPath,
						user: config.WORKSPACE_SSH_USER,
					},
				};

				const encoder = new TextEncoder();
				// Reassigned once the watcher is attached. A no-op until then, so the abort and
				// cancel paths can call it unconditionally.
				let unsubscribe: () => void = () => {};
				let keepalive: ReturnType<typeof setInterval> | undefined;

				const stream = new ReadableStream({
					cancel() {
						unsubscribe();
						clearInterval(keepalive);
					},
					start(controller) {
						const send = (snapshot: WorkspaceSnapshot) => {
							try {
								controller.enqueue(
									encoder.encode(`data: ${JSON.stringify(snapshot)}\n\n`),
								);
							} catch {
								// The client went away between the watcher emitting and this
								// enqueue. Unsubscribing here stops the loop that is now writing
								// to nobody.
								unsubscribe();
								clearInterval(keepalive);
							}
						};

						unsubscribe = watchWorkspace(
							params.workspaceId,
							target,
							agent,
							send,
						);

						keepalive = setInterval(() => {
							try {
								controller.enqueue(encoder.encode(": keepalive\n\n"));
							} catch {
								unsubscribe();
								clearInterval(keepalive);
							}
						}, KEEPALIVE_MS);

						// Fires when the client disconnects, which is the ordinary way a stream
						// ends: a closed tab or a navigation.
						request.signal.addEventListener("abort", () => {
							unsubscribe();
							clearInterval(keepalive);
							try {
								controller.close();
							} catch {
								// Already closed.
							}
						});
					},
				});

				return new Response(stream, {
					headers: {
						"cache-control": "no-cache, no-transform",
						connection: "keep-alive",
						"content-type": "text/event-stream",
						// Belt and braces with the Caddy config: some proxies honour this header
						// even when not told to stop buffering.
						"x-accel-buffering": "no",
					},
				});
			},
		},
	},
});
