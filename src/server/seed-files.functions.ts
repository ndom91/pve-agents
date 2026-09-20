import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import {
	removeSeedFile,
	saveSeedFile,
	seedFiles,
} from "../db/seed-file-repository";
import { seedFileSchema } from "../domain/seed-file";
import { controllerDatabase } from "./controller";
import { operatorMiddleware } from "./middleware";

// listSeedFiles returns what every new workspace will be seeded with.
//
// Destinations and sizes, never bodies. The page shows a list and the bodies can be a quarter of a
// megabyte each.
export const listSeedFiles = createServerFn({ method: "GET" })
	.middleware([operatorMiddleware])
	.handler(() => seedFiles(controllerDatabase()));

// saveWorkspaceSeedFile adds a file, or replaces whatever already claims its destination.
export const saveWorkspaceSeedFile = createServerFn({ method: "POST" })
	.middleware([operatorMiddleware])
	.validator(seedFileSchema)
	.handler(({ data }) => {
		const saved = saveSeedFile(controllerDatabase(), data);
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
