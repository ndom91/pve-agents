import { describe, expect, it } from "vitest";

import {
	ownershipMarker,
	ownershipMatches,
	parseOwnershipMarker,
} from "./proxmox-ownership";

const OWNERSHIP = {
	controllerID: "b66d3c5d-22c6-4199-889e-764f12d37fe5",
	createdAt: "2026-01-01T00:00:00.000Z",
	ownershipToken: "4a5d1c0e-4bd6-4a8f-9b1f-2c0d4e6f8a1b",
	workspaceID: "0f2c9b8a-1d3e-4f50-9a6b-7c8d9e0f1a2b",
};

describe("parseOwnershipMarker", () => {
	it("round-trips the marker written during clone", () => {
		expect(parseOwnershipMarker(ownershipMarker(OWNERSHIP))).toEqual({
			"controller-id": OWNERSHIP.controllerID,
			"created-at": OWNERSHIP.createdAt,
			"managed-by": "pve-agents",
			"ownership-token": OWNERSHIP.ownershipToken,
			"workspace-id": OWNERSHIP.workspaceID,
		});
	});

	it("tolerates blank lines and surrounding whitespace", () => {
		expect(
			parseOwnershipMarker("\n managed-by = pve-agents \n\nnoise\n"),
		).toEqual({ "managed-by": "pve-agents" });
	});

	it("returns nothing for an absent description", () => {
		expect(parseOwnershipMarker(undefined)).toEqual({});
	});
});

describe("ownershipMatches", () => {
	it("accepts a marker this controller wrote for this workspace", () => {
		expect(
			ownershipMatches(
				parseOwnershipMarker(ownershipMarker(OWNERSHIP)),
				OWNERSHIP,
			),
		).toBe(true);
	});

	it("rejects a marker differing in any single field", () => {
		for (const key of [
			"controllerID",
			"ownershipToken",
			"workspaceID",
		] as const) {
			const marker = parseOwnershipMarker(
				ownershipMarker({
					...OWNERSHIP,
					[key]: "00000000-0000-0000-0000-000000000000",
				}),
			);

			expect(ownershipMatches(marker, OWNERSHIP)).toBe(false);
		}
	});

	it("rejects a container managed by other software", () => {
		expect(
			ownershipMatches(
				parseOwnershipMarker("managed-by=something-else"),
				OWNERSHIP,
			),
		).toBe(false);
	});

	it("rejects an unmarked container", () => {
		expect(ownershipMatches(parseOwnershipMarker(undefined), OWNERSHIP)).toBe(
			false,
		);
		expect(
			ownershipMatches(
				parseOwnershipMarker("some hand-written note"),
				OWNERSHIP,
			),
		).toBe(false);
	});
});
