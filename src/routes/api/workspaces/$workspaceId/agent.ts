import { createFileRoute } from "@tanstack/react-router";

import {
	recordWorkspaceActivity,
	recordWorkspaceInteraction,
	workspaceDetail,
} from "../../../../db/workspace-repository";
import type { RunnerEvent } from "../../../../domain/runner-protocol";
import { mapActivity } from "../../../../domain/workspace";
import { requireOperator } from "../../../../server/authorize";
import {
	controllerDatabase,
	controllerRuntimeConfig,
} from "../../../../server/controller";
import { attachRunner } from "../../../../services/agent-runner";

type WorkspaceParams = { workspaceId: string };

// KEEPALIVE_MS keeps an idle stream from being closed by something in the middle.
//
// A thinking agent can say nothing for minutes, which a proxy or a browser eventually treats as a
// dead connection. A comment line costs two bytes and EventSource ignores it.
const KEEPALIVE_MS = 20_000;

// The agent stream forwards one workspace's runner to one open page.
//
// One SSH attachment per reader rather than one per workspace shared between them, which is what
// the old screen watcher did. The difference is that a screen is the same for everybody and a
// transcript replay is not: the runner's snapshot is sized by how much has happened, and a reader
// arriving late needs the whole thing before the live events make sense.
//
// Server-sent events rather than a socket. Everything the operator sends upward — a prompt, an
// approval — is one discrete request with an answer, which is what a server function already is.
// A socket earns its keep when there is keystroke-level input, and the Terminal tab is where that
// lives.
export const Route = createFileRoute("/api/workspaces/$workspaceId/agent")({
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
				const keyPath = config.WORKSPACE_SSH_KEY_PATH;

				// Refused rather than streamed as empty, so a caller can tell "nothing to watch"
				// from "watching, and quiet".
				if (
					workspace === undefined ||
					workspace.status !== "ready" ||
					workspace.ip === undefined ||
					keyPath === undefined
				) {
					return new Response("workspace is not watchable", { status: 409 });
				}

				const target = {
					address: workspace.ip,
					keyPath,
					user: config.WORKSPACE_SSH_USER,
				};

				const encoder = new TextEncoder();
				// Reassigned once attached. A no-op until then, so the abort and cancel paths can
				// call it unconditionally.
				let detach: () => void = () => {};
				let keepalive: ReturnType<typeof setInterval> | undefined;

				const stream = new ReadableStream({
					cancel() {
						detach();
						clearInterval(keepalive);
					},
					start(controller) {
						const stop = () => {
							detach();
							clearInterval(keepalive);
						};

						const runner = attachRunner(target, {
							onClose: () => {
								// Said out loud rather than swallowed. A runner that has gone away
								// leaves a page that looks merely quiet, and an operator waiting on
								// an agent that no longer exists.
								try {
									controller.enqueue(
										encoder.encode(
											`data: ${JSON.stringify({ type: "detached" })}\n\n`,
										),
									);
									controller.close();
								} catch {
									// Already closed.
								}
								stop();
							},
							onEvent: (event) => {
								record(params.workspaceId, event);

								try {
									controller.enqueue(
										encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
									);
								} catch {
									// The reader went away between the runner emitting and this
									// enqueue. Detaching here closes the ssh that is now writing to
									// nobody.
									stop();
								}
							},
						});

						detach = runner.close;
						// The snapshot first, then live events. A reader that only subscribed would
						// see an agent that appears idle while a parked approval waits inside it.
						runner.send({ type: "attach" });

						keepalive = setInterval(() => {
							try {
								controller.enqueue(encoder.encode(": keepalive\n\n"));
							} catch {
								stop();
							}
						}, KEEPALIVE_MS);
						// Unreferenced so a heartbeat on an idle stream is not what keeps the
						// process alive through a shutdown.
						keepalive.unref?.();

						// Fires when the client disconnects, which is the ordinary way a stream
						// ends: a closed tab or a navigation.
						request.signal.addEventListener("abort", () => {
							stop();
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

// record writes what the stream observes into the database.
//
// The same reasoning the screen stream recorded at length: a value that lives only in the browser
// cache is overwritten within seconds by whatever the thirty-second observer last stored, and the
// controls gated on it flicker or never appear. The database is the single source; this keeps it
// fresh to about as long as an event takes to arrive while a page is open.
//
// It also means the reaper's view of a blocked agent is as fresh as the operator's, which matters
// because that is the flag standing between an agent waiting for an answer and destruction.
function record(id: string, event: RunnerEvent): void {
	if (event.type !== "status" && event.type !== "snapshot") {
		return;
	}

	const { status } = event;

	recordWorkspaceActivity(controllerDatabase(), {
		activity: mapActivity(status),
		id,
	});
	// An agent seen working is the finest-grained evidence there is that somebody's work is still
	// moving, and it arrives here the moment it happens rather than on a thirty-second cadence.
	if (status === "working") {
		recordWorkspaceInteraction(controllerDatabase(), id);
	}
}
