import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import {
	readSeedFileContent,
	removeSeedFile,
	saveSeedFile,
	seedFiles,
} from "../db/seed-file-repository";
import { seedFileSchema } from "../domain/seed-file";
import { harness } from "../harness";
import { controllerDatabase, controllerRuntimeConfig } from "./controller";
import { operatorMiddleware } from "./middleware";

// listSeedFiles returns what every new workspace will be seeded with.
//
// Destinations and sizes, never bodies. The page shows a list and the bodies can be a quarter of a
// megabyte each.
export const listSeedFiles = createServerFn({ method: "GET" })
	.middleware([operatorMiddleware])
	.handler(() => seedFiles(controllerDatabase()));

// readSeedFile returns one file's body, for the editor about to show it.
//
// One at a time rather than folded into the list, which carries sizes and no bodies on purpose: a
// list that fetched every body to render a number is what that decision avoids.
export const readSeedFile = createServerFn({ method: "GET" })
	.middleware([operatorMiddleware])
	.validator(z.object({ id: z.string().min(1) }))
	.handler(({ data }) => ({
		// Absent rather than an error. A file removed in another tab while its editor was open is
		// an ordinary race, not a failure worth taking the page down for.
		content: readSeedFileContent(controllerDatabase(), data.id),
	}));

// saveWorkspaceSeedFile adds a file, updates one by id, or replaces whatever claims a destination.
export const saveWorkspaceSeedFile = createServerFn({ method: "POST" })
	.middleware([operatorMiddleware])
	.validator(seedFileSchema)
	.handler(({ data }) => {
		const saved = saveSeedFile(
			controllerDatabase(),
			harness(controllerRuntimeConfig().WORKSPACE_AGENT_HARNESS),
			data,
		);
		if (saved.kind === "invalid") {
			throw new Error(`seed file: ${saved.message}`);
		}

		return saved.file;
	});

// deleteWorkspaceSeedFile stops a file being applied to workspaces made from now on.
//
// Nothing already provisioned changes: those files were written into containers at provision time
// and this controller does not reach back into a running workspace to take them away.
export const deleteWorkspaceSeedFile = createServerFn({ method: "POST" })
	.middleware([operatorMiddleware])
	.validator(z.object({ id: z.string().min(1) }))
	.handler(({ data }) => {
		removeSeedFile(controllerDatabase(), data.id);

		return { kind: "removed" as const };
	});
