#!/usr/bin/env node

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

const CLIENT_DIR = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../dist/client",
);

const CONTENT_TYPES = {
	".css": "text/css; charset=utf-8",
	".html": "text/html; charset=utf-8",
	".ico": "image/x-icon",
	".js": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".map": "application/json; charset=utf-8",
	".png": "image/png",
	".svg": "image/svg+xml",
	".txt": "text/plain; charset=utf-8",
	".webp": "image/webp",
	".woff": "font/woff",
	".woff2": "font/woff2",
};

export function createServer(fetchHandler, clientDir = CLIENT_DIR) {
	return createHttpServer(async (request, response) => {
		// TanStack Start's fetch handler renders routes but does not serve the built client
		// bundle, so without this every asset 404s: no stylesheet, and no hydration, which leaves
		// the page rendered but completely inert.
		if (await serveStaticFile(request, response, clientDir)) {
			return;
		}

		return handleFetch(fetchHandler, request, response);
	});
}

async function serveStaticFile(request, response, clientDir) {
	if (request.method !== "GET" && request.method !== "HEAD") {
		return false;
	}

	const pathname = decodeURIComponent(
		new URL(requestUrl(request)).pathname,
	).replace(/\/+$/, "");
	if (pathname === "") {
		return false;
	}

	// normalize collapses any ".." before the prefix check, so a crafted path cannot escape the
	// client directory and read arbitrary files.
	const candidate = join(clientDir, normalize(pathname));
	if (candidate !== clientDir && !candidate.startsWith(clientDir + sep)) {
		return false;
	}

	let info;
	try {
		info = await stat(candidate);
	} catch {
		return false;
	}
	if (!info.isFile()) {
		return false;
	}

	response.statusCode = 200;
	response.setHeader(
		"content-type",
		CONTENT_TYPES[extname(candidate).toLowerCase()] ??
			"application/octet-stream",
	);
	response.setHeader("content-length", info.size);
	// Vite fingerprints these filenames, so a changed asset always has a new URL.
	response.setHeader(
		"cache-control",
		candidate.includes(`${sep}assets${sep}`)
			? "public, max-age=31536000, immutable"
			: "public, max-age=0, must-revalidate",
	);

	if (request.method === "HEAD") {
		response.end();

		return true;
	}

	createReadStream(candidate).pipe(response);

	return true;
}

function handleFetch(fetchHandler, request, response) {
	return (async () => {
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
	})();
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

	// The scheduler is a separate bundle so the HTTP server keeps starting even when it is off,
	// which is the default. Nothing here runs until WORKER_ENABLED=true.
	if (process.env.WORKER_ENABLED === "true") {
		const { startScheduler } = await import("../dist/cli/scheduler.js");
		const abort = new AbortController();
		for (const signal of ["SIGINT", "SIGTERM"]) {
			process.once(signal, () => {
				abort.abort();
				server.close();
			});
		}

		startScheduler(abort.signal).catch((error) => {
			console.error("scheduler stopped", error);
			process.exitCode = 1;
		});
	}
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		console.error("controller failed to start", error);
		process.exitCode = 1;
	});
}
