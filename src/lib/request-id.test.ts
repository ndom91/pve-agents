import { describe, expect, it } from "vitest";

import { requestId } from "./request-id";

describe("requestId", () => {
	it("returns 128 bits of hex", () => {
		expect(requestId()).toMatch(/^[0-9a-f]{32}$/);
	});

	it("does not repeat", () => {
		const seen = new Set(Array.from({ length: 500 }, () => requestId()));

		expect(seen.size).toBe(500);
	});

	it("is not called from browser code via a secure-context-only API", async () => {
		// The controller is served over plain HTTP on the LAN, an insecure context, where
		// crypto.randomUUID is undefined. Anything the browser runs must avoid it.
		const { readdirSync, readFileSync } = await import("node:fs");
		const offenders: string[] = [];
		for (const dir of ["src/routes", "src/lib"]) {
			for (const name of readdirSync(dir, { recursive: true }) as string[]) {
				if (!/\.tsx?$/.test(name) || name.includes(".test.")) {
					continue;
				}
				if (
					readFileSync(`${dir}/${name}`, "utf8").includes("crypto.randomUUID(")
				) {
					offenders.push(`${dir}/${name}`);
				}
			}
		}

		expect(offenders).toEqual([]);
	});
});
