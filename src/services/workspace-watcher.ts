import type { HerdrTarget } from "./herdr";
import { herdrAgentStatus, readHerdrAgent } from "./herdr";
import { runSsh, type SshRunner } from "./ssh";

// WorkspaceSnapshot is what a watcher reports about one agent.
export type WorkspaceSnapshot = {
	activity: string;
	screen: string;
};

// WatcherOptions exist so tests can drive the loop without a real clock or a real connection.
export type WatcherOptions = {
	intervalMs?: number;
	maxFailures?: number;
	ssh?: SshRunner;
};

// READ_INTERVAL_MS is how often a watched workspace is read.
//
// Far faster than the scheduler's thirty-second observation, and affordable for the opposite
// reason: this runs only while somebody has the page open, and stops when they leave.
const READ_INTERVAL_MS = 2_000;

// MAX_FAILURES stops a loop reading a container that is not answering.
//
// A stream holds a connection open, so without a bound a destroyed or wedged workspace would be
// reconnected to every two seconds for as long as a forgotten tab stayed open.
const MAX_FAILURES = 5;

type Subscriber = (snapshot: WorkspaceSnapshot) => void;

type Watcher = {
	last?: WorkspaceSnapshot;
	stop: () => void;
	subscribers: Set<Subscriber>;
};

// Keyed by workspace id, and shared across every connection watching that workspace.
//
// On globalThis rather than in module scope for the same reason the controller's database is: the
// server and the scheduler are separate bundles, and a plain Map would give each of them its own.
const REGISTRY = Symbol.for("pve-herdr-agents.watchers");

function registry(): Map<string, Watcher> {
	const host = globalThis as typeof globalThis & {
		[REGISTRY]?: Map<string, Watcher>;
	};
	if (host[REGISTRY] === undefined) {
		host[REGISTRY] = new Map();
	}

	return host[REGISTRY];
}

// watchWorkspace subscribes to one workspace's agent, returning an unsubscribe.
//
// One loop per workspace, not one per subscriber. Three open tabs on the same workspace must not
// mean three SSH connections into the same container: the feature would then punish exactly the
// workspace someone is paying the most attention to.
export function watchWorkspace(
	workspaceId: string,
	target: HerdrTarget,
	agent: string,
	onSnapshot: Subscriber,
	options: WatcherOptions = {},
): () => void {
	const watchers = registry();
	let watcher = watchers.get(workspaceId);

	if (watcher === undefined) {
		watcher = start(workspaceId, target, agent, options);
		watchers.set(workspaceId, watcher);
	}

	watcher.subscribers.add(onSnapshot);
	// A subscriber arriving mid-loop gets the current state rather than waiting for the next
	// change, which for an idle agent could be a long time.
	if (watcher.last !== undefined) {
		onSnapshot(watcher.last);
	}

	return () => {
		const current = watchers.get(workspaceId);
		if (current === undefined) {
			return;
		}

		current.subscribers.delete(onSnapshot);
		if (current.subscribers.size === 0) {
			current.stop();
			watchers.delete(workspaceId);
		}
	};
}

// watchedWorkspaces reports which workspaces currently have a loop, for tests and diagnostics.
export function watchedWorkspaces(): string[] {
	return [...registry().keys()];
}

function start(
	workspaceId: string,
	target: HerdrTarget,
	agent: string,
	options: WatcherOptions,
): Watcher {
	const ssh = options.ssh ?? runSsh;
	const intervalMs = options.intervalMs ?? READ_INTERVAL_MS;
	const maxFailures = options.maxFailures ?? MAX_FAILURES;

	let running = true;
	let failures = 0;
	const watcher: Watcher = {
		stop: () => {
			running = false;
		},
		subscribers: new Set(),
	};

	const loop = async () => {
		while (running) {
			const [pane, state] = await Promise.all([
				readHerdrAgent(target, agent, ssh, "visible", "ansi"),
				herdrAgentStatus(target, agent, ssh),
			]);

			if (pane.kind === "failed" || state.kind === "failed") {
				failures += 1;
				if (failures >= maxFailures) {
					running = false;
					registry().delete(workspaceId);

					return;
				}
			} else {
				failures = 0;
				const snapshot = { activity: state.status, screen: pane.text };
				// Only on change. An idle agent redraws nothing, so an open page that is watching
				// one costs a read every couple of seconds and nothing at all on the wire.
				if (
					watcher.last === undefined ||
					watcher.last.screen !== snapshot.screen ||
					watcher.last.activity !== snapshot.activity
				) {
					watcher.last = snapshot;
					for (const subscriber of watcher.subscribers) {
						subscriber(snapshot);
					}
				}
			}

			await new Promise((resolve) => setTimeout(resolve, intervalMs));
		}
	};

	void loop();

	return watcher;
}
