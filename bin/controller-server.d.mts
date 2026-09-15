import type { Server } from "node:http";

export function createServer(
	fetchHandler: (request: Request) => Promise<Response>,
): Server;
