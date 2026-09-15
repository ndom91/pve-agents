import { once } from "node:events";

import { afterEach, describe, expect, it } from "vitest";

import { createServer } from "../../bin/controller-server.mjs";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
	for (const server of servers) {
		server.close();
		await once(server, "close");
	}

	servers.length = 0;
});

describe("createServer", () => {
	it("adapts Node requests to Fetch requests", async () => {
		const server = createServer(async (request) => {
			return Response.json({
				body: await request.text(),
				method: request.method,
			});
		});
		servers.push(server);
		server.listen(0, "127.0.0.1");
		await once(server, "listening");

		const address = server.address();
		if (address === null || typeof address === "string") {
			throw new Error("expected TCP server address");
		}

		const response = await fetch(`http://127.0.0.1:${address.port}/workspace`, {
			body: "request body",
			method: "POST",
		});

		expect(await response.json()).toEqual({
			body: "request body",
			method: "POST",
		});
	});
});
