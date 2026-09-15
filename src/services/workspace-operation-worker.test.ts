import { describe, expect, it } from "vitest";

import { controllerConfig } from "../config/controller-config";
import { runWorkspaceOperations } from "./workspace-operation-worker";

describe("runWorkspaceOperations", () => {
	it("does not execute queued operations by default", () => {
		expect(runWorkspaceOperations(controllerConfig({}))).toEqual({
			processed: 0,
			status: "disabled",
		});
	});
});
