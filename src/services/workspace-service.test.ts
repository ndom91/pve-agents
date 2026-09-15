import { describe, expect, it } from "vitest";

import { workspaceRequest } from "./workspace-service";

describe("workspaceRequest", () => {
	it("accepts a request without purpose", () => {
		const result = workspaceRequest({
			repository: "git@github.com:plainhq/plain.git",
			ref: "main",
		});

		expect(result).toEqual({
			ok: true,
			request: {
				repository: "git@github.com:plainhq/plain.git",
				ref: "main",
			},
		});
	});
});
