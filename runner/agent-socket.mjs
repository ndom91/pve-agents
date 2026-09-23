// The half of a runner that is not about any particular agent: the socket the controller talks to.
//
// Shipped beside whichever runner is in use and imported relatively. One file per harness was the
// first shape, and it meant this framing -- which is subtle in the way all framing is subtle --
// existed once per agent. A third harness would have made a third copy.
//
// Plain JavaScript and no build step, like the runners themselves. These files are copied into a
// container over ssh and run by node directly, so a relative import is the only kind of sharing
// available: node resolves a sibling .mjs with no help, and `installRunner` already writes a
// package.json marking the directory as a module.

import { chmodSync, unlinkSync } from "node:fs";
import { createServer } from "node:net";

// serve accepts controller connections on a unix socket, newline-delimited JSON in both directions.
//
// A unix socket rather than a TCP port: a port would put an unauthenticated "drive this agent"
// endpoint on the workspace network and need its own authentication to close again. A socket
// reached over ssh inherits the key that already gates everything else the controller does.
//
// Returns only `broadcast`. The one reply that goes to a single caller rather than to everyone --
// the answer to a `snapshot` request -- is written to the client handed to `onRequest`, so no
// caller has needed the set itself.
export function serve({ onRequest, socket }) {
	const clients = new Set();

	function broadcast(event) {
		const line = `${JSON.stringify(event)}\n`;
		for (const client of clients) {
			client.write(line);
		}
	}

	// A socket left behind by a previous runner would make listen() fail with EADDRINUSE, which on a
	// container that has been restarted is the common case rather than the odd one.
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
					// Parsed here so neither runner has to. A line that is not JSON is dropped: the
					// controller is a separate deployable and there is nothing useful to say back.
					let request;
					try {
						request = JSON.parse(line);
					} catch {
						request = undefined;
					}
					if (request !== undefined) {
						onRequest(client, request);
					}
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

	return { broadcast };
}
