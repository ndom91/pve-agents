// The opencode2 runner: one opencode session, held open, reachable over a unix socket.
//
// Same protocol as the claude-code runner -- see src/domain/runner-protocol.ts -- and a completely
// different mechanism underneath, which is the point. claude-code is an in-process SDK with a
// suspended callback; opencode is a local HTTP server with an event bus.
//
// Everything this file knows about that server was observed by driving one, not read from a
// document. The OpenAPI document opencode serves at /openapi.json declares its event payloads as an
// opaque JSON string, so the event vocabulary below came from watching real sessions.
//
// Plain JavaScript and no build step, like its sibling. Copied into the container over ssh.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { serve } from "./agent-socket.mjs";

const SOCKET =
	process.env.RUNNER_SOCKET ?? `${process.env.HOME}/.agent-runner.sock`;

const CWD = process.env.RUNNER_CWD ?? "/workspace/repo";

// Reported in the snapshot so a page can say what the agent is running under, and read by nothing
// else here.
//
// opencode decides what to ask about from its agent's own permission list -- allow, ask or deny,
// per action and resource -- which an operator configures by seeding opencode's config. This runner
// does not second-guess it: every request it is given reaches a person.
const MODE = process.env.RUNNER_PERMISSION_MODE ?? "auto";

// Which model, as "providerID/modelID". Optional: opencode has its own default, and asking the
// server for it is better than this file carrying an opinion that goes stale.
const MODEL = process.env.RUNNER_MODEL;

// The server's own port, on loopback only. Not configurable and not reachable from outside the
// container: the ssh key gates the socket, and this is an implementation detail behind it.
const PORT = Number(process.env.RUNNER_OPENCODE_PORT ?? "39917");

const BASE = `http://127.0.0.1:${PORT}/api`;

// How many times to replace a server that dies before saying so and stopping.
//
// Six, with the backoff below, is about a minute and a half of trying. Enough to ride out a
// previous instance still holding the port; not enough to spend a night writing to a log.
const MAX_RESTARTS = 6;

// Where opencode keeps its own state, including the credential table this writes into.
const STORE = `${process.env.HOME}/.local/share/opencode/opencode.db`;

// The credential to write, as {"integration":"openai","value":"{…}"}.
//
// Written into a table rather than handed to an API because opencode has none that accepts one:
// PATCH /api/credential/{id} sets a label, connect/key takes an API key, and the OAuth routes need
// a person with a browser. A ChatGPT subscription is none of those.
const CREDENTIAL = process.env.OPENCODE_CREDENTIAL;

// The username opencode expects for HTTP Basic. A literal, not a name we chose.
//
// Worth stating because getting it wrong costs an hour: the server answers a wrong username with
// exactly the 401 it answers a wrong password with, so an unauthenticated runner looks like a
// credential problem rather than a spelling one.
const USER = "opencode";

function main() {
	const { broadcast } = serve({ onRequest: handle, socket: SOCKET });

	// Every message, in opencode's own shape. The harness's readTranscript turns these into rows;
	// nothing here interprets them, for the same reason the claude-code runner forwards the SDK's
	// messages untouched.
	let transcript = [];
	// Parked permission requests by id, as the controller's ApprovalRequest shape.
	const approvals = new Map();

	let password;
	let sessionId;
	let title;
	let working = false;
	let fatal;
	// The server process, and how many times it has been replaced. See ensureServer.
	let server;
	let restarts = 0;

	function status() {
		if (approvals.size > 0) {
			return "blocked";
		}

		return working ? "working" : "idle";
	}

	let last = status();
	function settle() {
		const now = status();
		if (now !== last) {
			last = now;
			broadcast({ status: now, type: "status" });
		}
	}

	function snapshot() {
		return {
			approvals: [...approvals.values()],
			cwd: CWD,
			harness: "opencode2",
			messages: transcript,
			permissionMode: MODE,
			sessionId,
			status: status(),
			title,
			type: "snapshot",
		};
	}

	// call is every request to the local server.
	//
	// Basic auth on each one rather than a session cookie, because the server hands out a password
	// and nothing else, and because a runner that reconnects should not have to re-establish
	// anything.
	async function call(path, { body, method = "GET" } = {}) {
		const response = await fetch(`${BASE}${path}`, {
			body: body === undefined ? undefined : JSON.stringify(body),
			headers: {
				authorization: `Basic ${Buffer.from(`${USER}:${password}`).toString("base64")}`,
				...(body === undefined ? {} : { "content-type": "application/json" }),
			},
			method,
		});
		if (!response.ok) {
			throw new Error(`${method} ${path} -> ${response.status}`);
		}
		if (response.status === 204) {
			return undefined;
		}

		// Every response is wrapped as {location, data}. Unwrapped here so no caller has to know.
		const payload = await response.json();

		return payload?.data;
	}

	// start launches the server and waits for it to say its password.
	//
	// The password is generated per start and written to stdout, so it has to be scraped. There is
	// no flag to set it and no file it lands in -- which is also why a server that dies cannot be
	// reattached to, only replaced. See ensureServer.
	//
	// Plain `serve` rather than `serve --service`: --service is a shared background instance, and
	// this controller expects one agent per workspace holding one session. Sharing one would make
	// two workspaces on the same container -- which cannot happen today -- silently the same agent.
	function start() {
		return new Promise((resolve, reject) => {
			password = undefined;
			server = spawn("opencode2", ["serve", "--port", String(PORT)], {
				cwd: CWD,
				stdio: ["ignore", "pipe", "pipe"],
			});

			let buffer = "";
			const timer = setTimeout(() => {
				reject(new Error("opencode2 serve did not report a password"));
			}, 60_000);

			server.stdout.setEncoding("utf8");
			server.stdout.on("data", (chunk) => {
				buffer += chunk;
				const found = /^server password (.+)$/m.exec(buffer);
				if (found !== null && password === undefined) {
					password = found[1].trim();
					clearTimeout(timer);
					resolve();
				}
			});

			// Kept, not discarded: when the server refuses to start this is the only account of why,
			// and it is the difference between a named failure and a silent one.
			server.stderr.setEncoding("utf8");
			server.stderr.on("data", (chunk) => process.stderr.write(chunk));

			server.on("exit", (code) => {
				clearTimeout(timer);
				process.stderr.write(`opencode2 serve exited with ${code}\n`);
				reject(new Error(`opencode2 serve exited with ${code}`));
			});
		});
	}

	// seedCredential puts the operator's credential in opencode's own store.
	//
	// Returns true when it wrote one, which the caller reads as "restart, so it is picked up". The
	// server reads credentials at start; it was still running when this row went in.
	//
	// Ordered after the first start on purpose. The database does not exist until opencode makes
	// it, and it arrives with forty-six migrations applied -- not something this side is going to
	// reproduce in order to save one restart on a workspace's first boot.
	//
	// Every failure here is soft and explains itself. `credential` is opencode's internal schema and
	// opencode2 is a beta, so of everything in this file it is the likeliest to change underneath
	// us. A workspace that comes up unauthenticated with a reason in its log is recoverable; a
	// runner that dies on boot is a workspace that never comes up at all.
	function seedCredential() {
		if (CREDENTIAL === undefined || CREDENTIAL === "") {
			return false;
		}

		let envelope;
		try {
			envelope = JSON.parse(CREDENTIAL);
		} catch {
			process.stderr.write(
				"OPENCODE_CREDENTIAL is not JSON; starting unauthenticated\n",
			);

			return false;
		}

		const integration = envelope?.integration;
		const value =
			typeof envelope?.value === "string"
				? envelope.value
				: JSON.stringify(envelope?.value);
		if (typeof integration !== "string" || value === undefined) {
			process.stderr.write(
				"OPENCODE_CREDENTIAL needs an integration and a value; starting unauthenticated\n",
			);

			return false;
		}

		let db;
		try {
			db = new DatabaseSync(STORE);
			// Only when there is none. A second row for the same integration is a second identity
			// for one account, and on a restarted runner it would be a new one every boot.
			const existing = db
				.prepare(
					"select count(*) as count from credential where integration_id = ?",
				)
				.get(integration);
			if ((existing?.count ?? 0) > 0) {
				return false;
			}

			const now = Date.now();
			db.prepare(
				`insert into credential
					(id, integration_id, label, value, active, time_created, time_updated)
				 values (?, ?, ?, ?, 1, ?, ?)`,
			).run(
				`cred_${randomUUID().replace(/-/g, "")}`,
				integration,
				integration,
				value,
				now,
				now,
			);
			process.stdout.write(`seeded the ${integration} credential\n`);

			return true;
		} catch (error) {
			process.stderr.write(
				`could not seed the credential, starting unauthenticated: ${String(error)}\n`,
			);

			return false;
		} finally {
			db?.close();
		}
	}

	// replaceServer stops the running server and starts another.
	//
	// It waits for the process to actually exit rather than returning on the kill. Two reasons, and
	// the second is the one that bites: ensureServer decides whether to start by reading
	// `exitCode`, which is still null in the moment after a kill -- so it would decide there was
	// nothing to do. And the new server binds the same port, which the old one is still holding
	// until it goes.
	function replaceServer() {
		return new Promise((done) => {
			const old = server;
			if (old === undefined || old.exitCode !== null) {
				done();

				return;
			}

			old.once("exit", () => done());
			old.kill();
		}).then(() => {
			// Not a restart as far as the counter is concerned. This one was asked for.
			restarts = 0;
			password = undefined;

			return ensureServer();
		});
	}

	// ensureServer guarantees there is a live server with a password we know.
	//
	// A restart rather than a reconnect, because the password is generated per start and only ever
	// written to stdout: a server that died takes the only copy of its credential with it, so the
	// runner cannot re-authenticate to a replacement it did not launch itself.
	//
	// This exists because of what happens without it, which was worth provoking rather than
	// imagining: kill the server under a running runner and the runner survives, answers its socket
	// with a stale snapshot, and retries the event stream once a second forever with a password
	// nothing will ever accept again. It looks healthy to the controller and is not.
	//
	// Bounded, so a server that cannot start -- a missing binary, a port taken -- becomes one fatal
	// the operator can read instead of a log growing by a line a second until the disk is full.
	async function ensureServer() {
		if (
			server !== undefined &&
			server.exitCode === null &&
			password !== undefined
		) {
			return;
		}
		if (restarts >= MAX_RESTARTS) {
			throw new Error(
				`opencode2 serve failed ${MAX_RESTARTS} times; giving up`,
			);
		}

		// Backs off to a half minute, and not at all the first time. A server failing for a reason
		// that will clear -- the previous one still holding the port -- wants a retry; one failing
		// for a reason that will not wants to stop filling a log.
		if (restarts > 0) {
			await new Promise((wake) =>
				setTimeout(wake, Math.min(30_000, 1000 * 2 ** (restarts - 1))),
			);
		}
		restarts += 1;
		await start();
	}

	// model resolves what to run, preferring what the operator asked for.
	//
	// Returns undefined when nothing was configured, which the session create reads as "your
	// default", rather than this runner guessing a model name that may not exist on this build.
	function model() {
		if (MODEL === undefined || MODEL === "") {
			return undefined;
		}

		const cut = MODEL.indexOf("/");
		if (cut === -1) {
			return undefined;
		}

		return { id: MODEL.slice(cut + 1), providerID: MODEL.slice(0, cut) };
	}

	// resync rebuilds the transcript and the pending approvals from the server.
	//
	// This is the heart of the file, and it exists because the event stream is lossy by its own
	// documented contract: a slow consumer overflows and fails the stream, and events during a
	// disconnection are missed entirely. So events are treated as a prompt to look, never as the
	// record itself -- the server holds the record.
	//
	// Called after every reconnection and at the end of every turn. Cheap enough to do often, and
	// the alternative is a transcript with a hole in the middle that nothing ever repairs.
	async function resync() {
		if (sessionId === undefined) {
			return;
		}

		try {
			const messages = await call(`/session/${sessionId}/message`);
			if (Array.isArray(messages)) {
				transcript = messages;
				broadcast({ ...snapshot(), type: "snapshot" });
			}

			const pending = await call(`/session/${sessionId}/permission`);
			if (Array.isArray(pending)) {
				// Replaced wholesale rather than merged. A request the server no longer lists was
				// answered by somebody else or expired, and keeping it would leave the workspace
				// permanently "blocked" with a button that does nothing.
				approvals.clear();
				for (const request of pending) {
					approvals.set(request.id, approval(request));
				}
				settle();
			}
		} catch (error) {
			// Not fatal. A failed resync means this pass learned nothing, and the next event or the
			// next turn tries again; tearing the runner down would lose a working session.
			process.stderr.write(`resync failed: ${String(error)}\n`);
		}
	}

	// approval turns opencode's permission request into the controller's shape.
	//
	// opencode describes what is being asked structurally -- an action and the resources it covers
	// -- where Claude's SDK hands over a sentence it composed itself. So the sentence is built here,
	// from the two fields, rather than left empty: the approval UI shows `title` and falling back to
	// a bare tool name would tell an operator nothing about what they are allowing.
	function approval(request) {
		const resources = (request.resources ?? []).join(", ");

		return {
			id: request.id,
			input: { action: request.action, resources: request.resources ?? [] },
			title:
				resources === ""
					? `opencode wants to ${request.action}`
					: `opencode wants to ${request.action}: ${resources}`,
			toolName: request.action,
			// The tool call this belongs to, so the UI marks the row that is actually waiting rather
			// than the most recent one with a matching name.
			toolUseId: request.source?.id,
		};
	}

	// listen subscribes to the event bus and keeps re-subscribing.
	//
	// A dropped stream is expected rather than exceptional -- see resync -- so this reconnects and
	// resyncs instead of reporting a failure. The delay is there so a server that refuses every
	// connection does not become a busy loop.
	async function listen() {
		for (;;) {
			try {
				// Before every attempt, not just the first. A stream that failed because the server
				// died is not a stream to retry; it is a server to replace.
				await ensureServer();

				const response = await fetch(`${BASE}/event`, {
					headers: {
						authorization: `Basic ${Buffer.from(`${USER}:${password}`).toString("base64")}`,
					},
				});
				if (!response.ok || response.body === null) {
					throw new Error(`event stream -> ${response.status}`);
				}

				let buffer = "";
				for await (const chunk of response.body) {
					buffer += Buffer.from(chunk).toString("utf8");
					let cut = buffer.indexOf("\n");
					while (cut !== -1) {
						const line = buffer.slice(0, cut);
						buffer = buffer.slice(cut + 1);
						if (line.startsWith("data: ")) {
							let event;
							try {
								event = JSON.parse(line.slice(6));
							} catch {
								event = undefined;
							}
							if (event !== undefined) {
								await observe(event);
							}
						}
						cut = buffer.indexOf("\n");
					}
				}

				// The stream ended cleanly. The server is still up, so this was the bus dropping a
				// consumer -- exactly the case it documents -- and the transcript needs checking.
				restarts = 0;
			} catch (error) {
				process.stderr.write(`event stream: ${String(error)}\n`);
				if (String(error).includes("giving up")) {
					// ensureServer has stopped trying, so this loop has nothing left to do. Said
					// once, out loud, rather than repeated to a log nobody is reading.
					fatal = String(error);
					broadcast({ message: fatal, type: "fatal" });

					return;
				}
			}

			await new Promise((wake) => setTimeout(wake, 1000));
			await resync();
		}
	}

	// observe reacts to one event.
	//
	// Only the events that change what the controller shows. opencode emits a great deal more --
	// usage accounting, instruction reloads, step boundaries, streaming deltas -- and forwarding all
	// of it would mean the browser reassembling a transcript the server will hand over complete.
	async function observe(event) {
		const data = event.data ?? {};
		if (data.sessionID !== undefined && data.sessionID !== sessionId) {
			// Another session on the same server. Cannot happen with one runner per workspace, but
			// the bus is server-wide and filtering is one line.
			return;
		}

		switch (event.type) {
			case "permission.asked": {
				// Always surfaced, never answered here.
				//
				// This used to auto-approve everything when the controller said "auto", which was a
				// second gate on a question opencode has already answered: its agent carries a
				// permission list -- allow, ask, deny, per action and resource -- and an ask has
				// already survived it. Rubber-stamping what got through means the operator never
				// sees the one thing the agent thought was worth asking about.
				const request = approval(data);
				approvals.set(request.id, request);
				broadcast({ approval: request, type: "approval" });
				settle();

				return;
			}
			case "permission.replied": {
				approvals.delete(data.id);
				broadcast({ id: data.id, type: "resolved" });
				settle();

				return;
			}
			case "session.execution.started": {
				working = true;
				settle();

				return;
			}
			case "session.execution.failed":
			case "session.execution.interrupted":
			case "session.execution.succeeded": {
				working = false;
				settle();
				// The turn is over, so this is the cheapest moment to be certain the transcript is
				// whole -- and the moment an operator is most likely to be reading it.
				await resync();

				return;
			}
			case "session.renamed": {
				// opencode names its own sessions, so unlike claude-code this costs no second query
				// and no model call of our own.
				if (typeof data.title === "string" && data.title !== "") {
					title = data.title;
					broadcast({ ...snapshot(), type: "snapshot" });
				}

				return;
			}
			default:
		}
	}

	// decide answers one parked permission request.
	async function decide(id, behavior) {
		try {
			await call(`/session/${sessionId}/permission/${id}/reply`, {
				body: { reply: behavior === "allow" ? "once" : "reject" },
				method: "POST",
			});
		} catch (error) {
			process.stderr.write(`decide ${id} failed: ${String(error)}\n`);
		}
	}

	// session creates one, once.
	async function session() {
		if (sessionId !== undefined) {
			return sessionId;
		}

		const created = await call("/session", {
			body: { location: { directory: CWD }, model: model() },
			method: "POST",
		});
		sessionId = created?.id;

		return sessionId;
	}

	function handle(client, request) {
		// Two ways to ask for the same answer. "snapshot" closes afterwards so a caller that sent a
		// prompt and then asked for state cannot receive its own status broadcast as the reply.
		if (request.type === "attach" || request.type === "snapshot") {
			client.write(`${JSON.stringify(snapshot())}\n`);
			if (fatal !== undefined) {
				client.write(`${JSON.stringify({ message: fatal, type: "fatal" })}\n`);
			}
			if (request.type === "snapshot") {
				client.end();
			}

			return;
		}

		if (request.type === "prompt" && typeof request.text === "string") {
			void (async () => {
				try {
					const id = await session();
					await call(`/session/${id}/prompt`, {
						body: { text: request.text },
						method: "POST",
					});
				} catch (error) {
					broadcast({ message: String(error), type: "fatal" });
				}
			})();

			return;
		}

		if (request.type === "decide" && typeof request.id === "string") {
			void decide(request.id, request.behavior);

			return;
		}

		if (request.type === "interrupt" && sessionId !== undefined) {
			void call(`/session/${sessionId}/interrupt`, { method: "POST" }).catch(
				(error) => process.stderr.write(`interrupt failed: ${String(error)}\n`),
			);
		}
	}

	void (async () => {
		try {
			await ensureServer();

			// The first start is what creates the store, so the credential goes in behind it and
			// the server is replaced to read it. Once only: on every later boot the row is already
			// there, seedCredential says so by returning false, and this costs nothing.
			if (seedCredential()) {
				await replaceServer();
			}

			// Created up front rather than on the first prompt, so that attaching to a fresh
			// workspace shows a session rather than nothing, and so the event filter above has an
			// id to compare against before any turn happens.
			//
			// It survives a server restart: opencode keeps its sessions in a database, so the id
			// stays valid and resync picks the transcript back up where it was.
			await session();
			await listen();
		} catch (error) {
			const message = String(error);
			fatal = message;
			broadcast({ message, type: "fatal" });
		}
	})();
}

main();
