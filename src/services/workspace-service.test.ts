import { describe, expect, it } from "vitest";

import { workspaceRequestSchema } from "./workspace-service";

describe("workspaceRequestSchema", () => {
	it("accepts a request without purpose", () => {
		const result = workspaceRequestSchema.parse({
			repository: "git@github.com:plainhq/plain.git",
			ref: "main",
		});

		expect(result).toEqual({
			repository: "git@github.com:plainhq/plain.git",
			ref: "main",
		});
	});
});
