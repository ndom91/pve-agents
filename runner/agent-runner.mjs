// The agent runner: one Claude Code session, held open, reachable over a unix socket.
//
// This runs *inside a workspace container*, not on the controller. It is shipped there over SSH at
// provision time rather than baked into the template, so changing it is a controller deploy rather
// than a template rebuild. Only the SDK itself lives in the template.
//
// It replaced reading a terminal. The controller used to run Claude Code as a TUI in a Herdr pane,
// scrape the rendered viewport every two seconds, and answer permission dialogs by typing "1" into
// the pane. Everything here exists because `query()` offers the real versions of those: typed
// messages instead of a screen, and a `canUseTool` callback instead of a keystroke.
//
// Plain JavaScript and no build step. It is copied to a container as one file and run by node
// directly, so anything that needed compiling would need a pipeline on the far side of an ssh.

import { randomUUID } from "node:crypto";
import { chmodSync, unlinkSync } from "node:fs";
import { createServer } from "node:net";

import { query } from "@anthropic-ai/claude-agent-sdk";

// Where the controller finds us. A unix socket rather than a TCP port: a port would put an
// unauthenticated "drive this agent" endpoint on the workspace network and need its own
// authentication to close again. A socket reached over ssh inherits the key that already gates
// everything else the controller does.
const SOCKET =
	process.env.RUNNER_SOCKET ?? `${process.env.HOME}/.agent-runner.sock`;

// Where the agent works. The checkout, not the home directory: an agent rooted in /home/agent
// finds no repository and says so in a way that reads like a model failure.
const CWD = process.env.RUNNER_CWD ?? "/workspace/repo";

// How much the agent may do without asking. Passed in because it is policy, tuned against a
// running fleet, rather than a property of the container.
//
// Worth knowing: the SDK's own built-in default is Manual, not auto, so this is always sent
// explicitly. And when auto mode is unavailable — an unsupported model, a settings file turning it
// off, or Anthropic turning it off server-side — Claude Code silently starts in Manual and stays
// there for the whole session. That degrades safely here, because every call then reaches the
// approval UI, but it has to be *visible* or "why is it asking me about everything" has no answer.
// The snapshot carries the mode we asked for so the controller can say what happened.
const MODE = process.env.RUNNER_PERMISSION_MODE ?? "auto";

// Bounds the session. There is no top-level timeout in the SDK: a session does not stop on its
// own, and an agent in a loop would otherwise run until the container is destroyed.
const MAX_TURNS = Number(process.env.RUNNER_MAX_TURNS ?? "200");

function main() {
	const turns = queue();
	const clients = new Set();
	// Every message except the partials. Replayed to whoever attaches, which is what lets a
	// reloaded page and a restarted controller both catch up without a transcript on disk.
	const transcript = [];
	// Parked permission requests, by id. A promise resolver per entry: the tool call is genuinely
	// suspended inside the SDK until one of these is called.
	const pending = new Map();

	let sessionId;
	let working = false;

	function status() {
		if (pending.size > 0) {
			// Asserted rather than inferred. The reaper refuses to destroy a blocked agent, and
			// that rule used to rest on Herdr's classification of a rendered dialog; it now rests
			// on a callback that is actually suspended.
			return "blocked";
		}

		return working ? "working" : "idle";
	}

	function broadcast(event) {
		const line = `${JSON.stringify(event)}\n`;
		for (const client of clients) {
			client.write(line);
		}
	}

	let last = status();
	function announce() {
		const now = status();
		if (now !== last) {
			last = now;
			broadcast({ status: now, type: "status" });
		}
	}

	// canUseTool parks the request and waits. It may wait for hours: the SDK puts no ceiling on it,
	// and a person is the point.
	//
	// The bridge composes the prompt sentence itself — `title` is "Claude wants to read foo.txt"
	// and `displayName` is a short noun phrase like "Read file". Both are forwarded rather than
	// rebuilt from the tool name and its input, because reconstructing them means reimplementing a
	// renderer per tool and getting it subtly wrong for the ones nobody tested.
	async function canUseTool(toolName, input, options) {
		const id = randomUUID();
		const request = {
			blockedPath: options?.blockedPath,
			decisionReason: options?.decisionReason,
			displayName: options?.displayName,
			id,
			input,
			title: options?.title,
			toolName,
			// The id of the tool_use block this call belongs to. Forwarded so the UI can mark the
			// row that is actually waiting rather than guessing at the most recent one with a
			// matching name, which picks the wrong one whenever two calls run at once.
			toolUseId: options?.toolUseID,
		};

		return await new Promise((resolve) => {
			pending.set(id, { request, resolve });
			broadcast({ approval: request, type: "approval" });
			announce();

			// The turn is being abandoned — an interrupt, or the query ending. Denying rather than
			// leaving the promise dangling, which would hold the SDK's loop open forever.
			options?.signal?.addEventListener("abort", () => {
				if (pending.delete(id)) {
					announce();
					resolve({ behavior: "deny", message: "the turn was interrupted" });
				}
			});
		});
	}

	const running = query({
		prompt: turns.stream,
		options: {
			canUseTool,
			cwd: CWD,
			// Token-level deltas, so text arrives as it is written rather than landing in a block
			// once a paragraph is finished.
			includePartialMessages: true,
			maxTurns: MAX_TURNS,
			permissionMode: MODE,
			// Ask for thinking we can actually show.
			//
			// Without this the blocks arrive with an empty `thinking` and a signature: the
			// reasoning is encrypted and the client never sees it, so the UI had a "Thought" row
			// with nothing behind it. "summarized" is the display mode that returns readable text.
			// If a model declines to summarise, the block stays empty and the row is dropped
			// rather than rendered as a disclosure that will not disclose.
			thinking: { display: "summarized", type: "adaptive" },
			// `settingSources` is deliberately not set. Its default loads user, project and local,
			// which is what makes the checked-out repository's own CLAUDE.md and .claude/settings
			// apply. The SDK's multi-tenant advice says to disable them; that is for one container
			// serving many tenants, and this container serves one workspace.
		},
	});

	serve({
		clients,
		onLine: (client, line) => handle(client, line),
		socket: SOCKET,
	});

	function handle(client, line) {
		let request;
		try {
			request = JSON.parse(line);
		} catch {
			return;
		}

		if (request.type === "attach") {
			// A replay, not just a subscription. A controller that restarts leaves approvals parked
			// in a runner that is still alive, and an attach that only streamed what happened next
			// would show an idle agent that is actually waiting for an answer.
			client.write(
				`${JSON.stringify({
					approvals: [...pending.values()].map((entry) => entry.request),
					cwd: CWD,
					messages: transcript,
					permissionMode: MODE,
					sessionId,
					status: status(),
					type: "snapshot",
				})}\n`,
			);

			return;
		}

		if (request.type === "prompt" && typeof request.text === "string") {
			working = true;
			announce();

			const turn = {
				message: { content: request.text, role: "user" },
				// Stamped explicitly. An absent origin is treated as unattributed and fails closed
				// at the SDK's strict isHuman() gates, so a prompt a person typed would be trusted
				// less than one they typed.
				origin: { kind: "human" },
				parent_tool_use_id: null,
				type: "user",
			};

			// Recorded and broadcast here, because `query()` does not yield back the turns it is
			// fed. Without this the operator's own prompts are missing from the conversation: you
			// type a question, it vanishes, and an answer appears with nothing above it. The runner
			// is the one that knows what was sent, so it is the one that says so.
			transcript.push(turn);
			broadcast({ message: turn, type: "message" });
			turns.push(turn);

			return;
		}

		if (request.type === "decide" && typeof request.id === "string") {
			const entry = pending.get(request.id);
			if (entry === undefined) {
				return;
			}

			pending.delete(request.id);
			// Told to everyone, not just the client that answered. Two open pages showing the same
			// workspace must not both keep offering a decision that has been made.
			broadcast({ id: request.id, type: "resolved" });
			announce();
			entry.resolve(
				request.behavior === "allow"
					? { behavior: "allow", updatedInput: entry.request.input }
					: {
							behavior: "deny",
							message:
								typeof request.message === "string" && request.message !== ""
									? request.message
									: "the operator declined",
						},
			);

			return;
		}

		if (request.type === "interrupt") {
			void running.interrupt().catch(() => undefined);
		}
	}

	void (async () => {
		try {
			for await (const message of running) {
				if (message.type === "stream_event") {
					// Forwarded but never kept. These are token deltas: a single long turn is
					// thousands of them, and a transcript holding every one would grow without
					// bound for data the completed assistant message already contains.
					broadcast({ message, type: "message" });
					continue;
				}

				if (message.type === "system" && message.subtype === "init") {
					sessionId = message.session_id;
				}
				if (message.type === "result") {
					working = false;
				}

				transcript.push(message);
				broadcast({ message, type: "message" });
				announce();
			}
		} catch (error) {
			broadcast({ message: String(error), type: "fatal" });
		} finally {
			working = false;
			broadcast({ status: "ended", type: "status" });
		}
	})();
}

// queue turns pushed messages into the async iterable the SDK consumes.
//
// This is how a second prompt reaches a running agent. The TypeScript SDK has no session object to
// call twice: `query()` takes one iterable and reads from it for the life of the session, so the
// iterable has to be something we can still write to afterwards.
function queue() {
	const waiting = [];
	const ready = [];

	return {
		push(value) {
			const next = waiting.shift();
			if (next === undefined) {
				ready.push(value);

				return;
			}

			next({ done: false, value });
		},
		stream: {
			[Symbol.asyncIterator]() {
				return {
					next() {
						const value = ready.shift();
						if (value !== undefined) {
							return Promise.resolve({ done: false, value });
						}

						// Never resolves until something is pushed, which is exactly right: the
						// session stays open with no turn in flight rather than ending because
						// nobody has typed anything yet.
						return new Promise((resolve) => waiting.push(resolve));
					},
				};
			},
		},
	};
}

// serve accepts controller connections on the socket, newline-delimited JSON in both directions.
function serve({ clients, onLine, socket }) {
	// A socket left behind by a previous runner would make listen() fail with EADDRINUSE, which on
	// a container that has been restarted is the common case rather than the odd one.
	try {
		unlinkSync(socket);
	} catch {
		// Nothing there, which is the ordinary case.
	}

	const server = createServer((client) => {
		clients.add(client);
		client.setEncoding("utf8");

		let buffer = "";
		client.on("data", (chunk) => {
			buffer += chunk;
			// A line at a time. TCP-shaped framing applies to unix sockets too: one write does not
			// arrive as one read, and a long tool input is reliably split.
			let cut = buffer.indexOf("\n");
			while (cut !== -1) {
				const line = buffer.slice(0, cut);
				buffer = buffer.slice(cut + 1);
				if (line.trim() !== "") {
					onLine(client, line);
				}
				cut = buffer.indexOf("\n");
			}
		});

		const drop = () => clients.delete(client);
		client.on("close", drop);
		// Without this a controller that goes away mid-write takes the whole runner down with an
		// unhandled ECONNRESET, and with it the agent's session.
		client.on("error", drop);
	});

	server.listen(socket, () => {
		// The ssh key already decides who reaches this container at all. This is the second lock:
		// nothing running as another user in the container can drive the agent.
		chmodSync(socket, 0o600);
		process.stdout.write(`listening on ${socket}\n`);
	});
}

main();
