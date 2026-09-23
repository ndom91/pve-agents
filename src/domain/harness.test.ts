import { describe, expect, it } from "vitest";

// Imported for its side effect, which is the registration. The registry starts empty: nothing is
// discovered, so a build supports exactly the harnesses one module names.
import "../harness";
import { type Harness, harness, harnessNames, register } from "./harness";
import type { TranscriptEntry } from "./transcript";

// A second harness, registered only here.
//
// The point of it is that it agrees with claude-code about nothing: a different credential
// variable, a different bootstrap file, a different runner, a different merge rule, and a
// transcript reader for a wire format that is not Anthropic's. An interface with one
// implementation is a description of that implementation, and every one of these is a place the
// real one could have been assumed.
const FAKE: Harness = {
	bootstrap: (cwd) => [
		{ contents: cwd, path: "$HOME/.fake/where" },
		{ contents: "yes", path: "$HOME/.config/fake.toml" },
	],
	credential: { env: "FAKE_API_KEY" },
	merges: (path) => path === "fake.json",
	name: "fake",
	readTranscript: (messages) =>
		messages.map(
			(message) =>
				({ kind: "say", text: String(message) }) satisfies TranscriptEntry,
		),
	runner: "fake-runner.mjs",
};

register(FAKE);

describe("harness", () => {
	it("resolves a registered harness by name", () => {
		expect(harness("fake").name).toBe("fake");
		expect(harness("claude-code").name).toBe("claude-code");
	});

	it("throws on a name it does not know, rather than falling back", () => {
		// A controller configured for a harness that does not exist has been misconfigured, and
		// quietly running a different agent than the one asked for is the worst available answer:
		// it would look like it worked.
		expect(() => harness("codex")).toThrow(/unknown agent harness "codex"/);
	});

	it("names what it does know, so a typo is one message rather than a hunt", () => {
		expect(() => harness("claude")).toThrow(/claude-code/);
	});

	it("lists what is registered", () => {
		expect(harnessNames()).toContain("claude-code");
		expect(harnessNames()).toContain("fake");
	});
});

describe("a harness that agrees with claude-code about nothing", () => {
	it("brings its own bootstrap files, however many", () => {
		// claude-code writes one. Nothing in the interface says one, and the provisioner writes
		// whatever comes back.
		expect(FAKE.bootstrap("/workspace/repo")).toEqual([
			{ contents: "/workspace/repo", path: "$HOME/.fake/where" },
			{ contents: "yes", path: "$HOME/.config/fake.toml" },
		]);
	});

	it("brings its own credential variable", () => {
		// The name the agent itself reads, which is not the controller's config key and not
		// Claude's.
		expect(FAKE.credential.env).toBe("FAKE_API_KEY");
		expect(harness("claude-code").credential.env).toBe(
			"CLAUDE_CODE_OAUTH_TOKEN",
		);
	});

	it("brings its own merge rule, including none", () => {
		expect(FAKE.merges("fake.json")).toBe(true);
		expect(FAKE.merges(".claude.json")).toBe(false);
		expect(harness("claude-code").merges("fake.json")).toBe(false);
	});

	it("brings its own runner", () => {
		expect(FAKE.runner).not.toBe(harness("claude-code").runner);
	});

	it("reaches the same TranscriptEntry from a different wire format", () => {
		// The contract. The feed, the tool groups and the approval rows all read this shape and
		// none of them knows which agent produced it.
		expect(FAKE.readTranscript(["one", "two"], [])).toEqual([
			{ kind: "say", text: "one" },
			{ kind: "say", text: "two" },
		]);
	});
});
