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

	it("refuses a harness it could not run, at startup rather than at provision time", () => {
		// The alternative is that this starts cleanly and then throws inside the agent step, once
		// per workspace, as a provisioning failure. A typo in .env should cost one error on boot.
		//
		// Loose between the words: controllerConfig throws zod's issue list as JSON, as it does for
		// every other field, so the quotes around the name arrive escaped.
		expect(() =>
			controllerConfig({ WORKSPACE_AGENT_HARNESS: "claude-cod" }),
		).toThrow(/unknown agent harness .*claude-cod/);
	});

	it("names what it could run, so the fix is in the message", () => {
		expect(() =>
			controllerConfig({ WORKSPACE_AGENT_HARNESS: "codex" }),
		).toThrow(/claude-code/);
	});

	it("defaults to a harness that is actually registered", () => {
		// Guards the pair: the schema's default and the registry have to agree, or every controller
		// without the variable set fails to start.
		expect(controllerConfig({}).WORKSPACE_AGENT_HARNESS).toBe("claude-code");
	});
});
