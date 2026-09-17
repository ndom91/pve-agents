import { afterEach, describe, expect, it } from "vitest";

import type { SshResult, SshRunner } from "./ssh";
import {
	type WorkspaceSnapshot,
	watchedWorkspaces,
	watchWorkspace,
} from "./workspace-watcher";

const TARGET = {
	session: "agents",
	ssh: { address: "10.0.3.100", keyPath: "/keys/id", user: "agent" },
};

const unsubscribes: (() => void)[] = [];

afterEach(() => {
	for (const stop of unsubscribes) {
		stop();
	}

	unsubscribes.length = 0;
});

// agent fakes a workspace, counting the reads so a second loop cannot hide.
function agent(screens: string[], status = "idle") {
	const state = { reads: 0 };
	let index = 0;

	const ssh: SshRunner = async (_target, command): Promise<SshResult> => {
		const line = command.join(" ");
		if (line.includes("agent read")) {
			state.reads += 1;
			const screen = screens[Math.min(index, screens.length - 1)] ?? "";
			index += 1;

			return { code: 0, kind: "ran", stderr: "", stdout: screen };
		}

		return {
			code: 0,
			kind: "ran",
			stderr: "",
			stdout: JSON.stringify({ result: { agent: { agent_status: status } } }),
		};
	};

	return { ssh, state };
}

function watch(
	id: string,
	ssh: SshRunner,
	onSnapshot: (snapshot: WorkspaceSnapshot) => void,
	intervalMs = 5,
) {
	const stop = watchWorkspace(id, TARGET, "agent-1", onSnapshot, {
		intervalMs,
		ssh,
	});
	unsubscribes.push(stop);

	return stop;
}

const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

describe("watchWorkspace", () => {
	it("runs one loop however many subscribers attach", async () => {
		// The property the whole design turns on. Three open tabs on one workspace must not be
		// three SSH connections into the same container, or watching a workspace closely becomes
		// the thing that loads it most.
		const { ssh, state } = agent(["one", "two", "three", "four"]);
		watch("w", ssh, () => undefined);
		watch("w", ssh, () => undefined);
		watch("w", ssh, () => undefined);

		await settle();

		expect(watchedWorkspaces()).toEqual(["w"]);
		const afterThree = state.reads;

		// A single subscriber over the same span would read the same number of times.
		const solo = agent(["one", "two", "three", "four"]);
		watch("solo", solo.ssh, () => undefined);
		await settle();

		expect(afterThree).toBeLessThanOrEqual(solo.state.reads + 2);
	});

	it("keeps reading while any subscriber remains", async () => {
		const { ssh, state } = agent(["one", "two"]);
		const first = watch("w", ssh, () => undefined);
		watch("w", ssh, () => undefined);

		first();
		await settle();

		expect(watchedWorkspaces()).toContain("w");
		expect(state.reads).toBeGreaterThan(0);
	});

	it("stops when the last subscriber leaves", async () => {
		const { ssh, state } = agent(["one", "two"]);
		const stop = watch("w", ssh, () => undefined);

		await settle();
		stop();
		const atStop = state.reads;
		await settle();

		expect(watchedWorkspaces()).not.toContain("w");
		// One read may already be in flight when the last subscriber leaves; what must not happen
		// is the loop carrying on.
		expect(state.reads).toBeLessThanOrEqual(atStop + 1);
	});

	it("starts a fresh loop when someone comes back", async () => {
		const first = agent(["one"]);
		const stop = watch("w", first.ssh, () => undefined);
		await settle();
		stop();
		await settle();

		const second = agent(["two"]);
		watch("w", second.ssh, () => undefined);
		await settle();

		expect(watchedWorkspaces()).toContain("w");
		expect(second.state.reads).toBeGreaterThan(0);
	});

	it("emits only when something actually changed", async () => {
		// An idle agent redraws nothing. Sending an identical screen every two seconds would make
		// a quiet workspace as expensive on the wire as a busy one.
		const { ssh } = agent(["same"]);
		const snapshots: WorkspaceSnapshot[] = [];
		watch("w", ssh, (snapshot) => snapshots.push(snapshot));

		await settle(60);

		expect(snapshots).toHaveLength(1);
		expect(snapshots[0]?.screen).toBe("same");
	});

	it("hands a late subscriber the current state at once", async () => {
		// Otherwise joining a quiet workspace shows nothing until it next changes, which for an
		// idle agent could be a very long time.
		const { ssh } = agent(["already here"]);
		watch("w", ssh, () => undefined);
		await settle();

		const late: WorkspaceSnapshot[] = [];
		watch("w", ssh, (snapshot) => late.push(snapshot));

		expect(late).toHaveLength(1);
		expect(late[0]?.screen).toBe("already here");
	});

	it("gives up on a workspace that will not answer", async () => {
		// A stream holds a connection open, so a forgotten tab on a dead container would otherwise
		// reconnect to it every couple of seconds indefinitely.
		const refusing: SshRunner = async () => ({ kind: "refused" });
		watchWorkspace("w", TARGET, "agent-1", () => undefined, {
			intervalMs: 2,
			maxFailures: 3,
			ssh: refusing,
		});

		await settle(60);

		expect(watchedWorkspaces()).not.toContain("w");
	});
});
