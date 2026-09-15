import { describe, expect, it } from "vitest";

import { controllerConfig } from "./controller-config";

describe("controllerConfig", () => {
	it("disables provisioning by default", () => {
		expect(controllerConfig({}).provisioningEnabled).toBe(false);
	});

	it("requires Proxmox configuration when provisioning is enabled", () => {
		expect(() => controllerConfig({ PROVISIONING_ENABLED: "true" })).toThrow(
			"PROXMOX_URL is required when PROVISIONING_ENABLED=true",
		);
	});

	it("requires a stable controller ID when provisioning is enabled", () => {
		expect(() => controllerConfig({ PROVISIONING_ENABLED: "true" })).toThrow(
			"CONTROLLER_ID is required when PROVISIONING_ENABLED=true",
		);
	});

	it("refuses to enable provisioning without an auth secret", () => {
		// Enabling provisioning turns the HTTP API into something that clones and purges real
		// containers. It must not be possible to do that with the mutating routes left open.
		expect(() => controllerConfig({ PROVISIONING_ENABLED: "true" })).toThrow(
			"CONTROLLER_AUTH_SECRET is required when PROVISIONING_ENABLED=true",
		);
	});

	it("rejects an auth secret too short to be worth having", () => {
		expect(() =>
			controllerConfig({ CONTROLLER_AUTH_SECRET: "short" }),
		).toThrow();
	});
});
