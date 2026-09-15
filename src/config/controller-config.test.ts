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
});
