#!/usr/bin/env node

import { createServer as createHttpServer } from "node:http";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";

export function createServer(fetchHandler) {
	return createHttpServer(async (request, response) => {
		const abort = new AbortController();
		// Abort on a premature response close, not on the request stream closing. The request
		// emits "close" as soon as its body has been fully read, so aborting there cancels every
		// handler that awaits anything after reading the body.
		response.once("close", () => {
			if (!response.writableEnded) {
				abort.abort();
			}
		});

		try {
			const handlerResponse = await fetchHandler(
				new Request(requestUrl(request), {
					body: request.method === "GET" || request.method === "HEAD" ? undefined : Readable.toWeb(request),
					duplex: "half",
					headers: requestHeaders(request),
					method: request.method,
					signal: abort.signal,
				}),
			);

			response.statusCode = handlerResponse.status;
			for (const [name, value] of handlerResponse.headers) {
				response.setHeader(name, value);
			}
			if (typeof handlerResponse.headers.getSetCookie === "function") {
				response.setHeader("set-cookie", handlerResponse.headers.getSetCookie());
			}

			if (handlerResponse.body === null) {
				response.end();

				return;
			}

			Readable.fromWeb(handlerResponse.body).pipe(response);
		} catch (error) {
			if (abort.signal.aborted) {
				return;
			}

			console.error("controller request failed", error);
			response.statusCode = 500;
			response.end("internal server error");
		}
	});
}

function requestHeaders(request) {
	const headers = new Headers();
	for (const [name, value] of Object.entries(request.headers)) {
		if (value === undefined) {
			continue;
		}

		if (Array.isArray(value)) {
			for (const item of value) {
				headers.append(name, item);
			}

			continue;
		}

		headers.set(name, value);
	}

	return headers;
}

function requestUrl(request) {
	const host = request.headers.host ?? "127.0.0.1";
	return `http://${host}${request.url ?? "/"}`;
}

async function main() {
	const host = process.env.CONTROLLER_HOST ?? "127.0.0.1";
	const port = Number.parseInt(process.env.CONTROLLER_PORT ?? "3000", 10);
	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new Error("CONTROLLER_PORT must be an integer between 1 and 65535");
	}

	const { default: controller } = await import("../dist/server/server.js");
	const server = createServer(controller.fetch);
	server.listen(port, host, () => {
		console.log(`controller listening on http://${host}:${port}`);
	});
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		console.error("controller failed to start", error);
		process.exitCode = 1;
	});
}
