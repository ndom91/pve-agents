import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import {
	deleteHarness,
	enabledHarnesses,
	harnesses,
	saveHarness,
} from "../db/harness-repository";
import { harnessConfigSchema } from "../domain/harness-config";
import { harnessNames } from "../harness";
import { controllerDatabase } from "./controller";
import { operatorMiddleware } from "./middleware";

// listHarnesses returns what an operator has set up.
//
// Never a credential. The shape it returns has no field for one -- see HarnessConfig -- so this is
// enforced by the type rather than by a line someone can delete.
export const listHarnesses = createServerFn({ method: "GET" })
	.middleware([operatorMiddleware])
	.handler(() => harnesses(controllerDatabase()));

// listHarnessKinds returns what this build can drive.
//
// From the registry rather than a list in the browser, because the answer is a property of the
// deployment: a controller running an older build should not offer a harness it cannot start.
export const listHarnessKinds = createServerFn({ method: "GET" })
	.middleware([operatorMiddleware])
	.handler(() => harnessNames());

// listLaunchableHarnesses returns what a new workspace can be launched on.
//
// Separate from listHarnesses because the settings page shows the disabled ones -- that is how they
// get re-enabled -- and the launch form must not offer them.
export const listLaunchableHarnesses = createServerFn({ method: "GET" })
	.middleware([operatorMiddleware])
	.handler(() => enabledHarnesses(controllerDatabase()));

// saveWorkspaceHarness adds a harness or updates one by id.
export const saveWorkspaceHarness = createServerFn({ method: "POST" })
	.middleware([operatorMiddleware])
	.validator(harnessConfigSchema)
	.handler(({ data }) => {
		// Checked here rather than in the schema, so the schema stays a description of the shape and
		// the registry stays the one answer to "what can this build run". A kind that is not
		// registered would provision a workspace that cannot start its agent.
		if (!harnessNames().includes(data.kind)) {
			throw new Error(
				`harness: this controller cannot run "${data.kind}"; it knows ${harnessNames().join(", ")}`,
			);
		}

		const saved = saveHarness(controllerDatabase(), data);
		if (saved.kind === "invalid") {
			throw new Error(`harness: ${saved.message}`);
		}

		return saved.harness;
	});

// deleteWorkspaceHarness removes one.
//
// Workspaces already provisioned on it keep running untouched: their runner is installed and their
// credential was written into their container at provision time, so nothing about them reads this
// row again.
export const deleteWorkspaceHarness = createServerFn({ method: "POST" })
	.middleware([operatorMiddleware])
	.validator(z.object({ id: z.string().min(1) }))
	.handler(({ data }) => {
		deleteHarness(controllerDatabase(), data.id);

		return { deleted: true };
	});
