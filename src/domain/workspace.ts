// DEFAULT_WORKSPACE_ACTIVITY is the initial observed agent activity for a new workspace.
export const DEFAULT_WORKSPACE_ACTIVITY = "unknown";

// DEFAULT_WORKSPACE_STATUS is the initial observed lifecycle status for a new workspace.
export const DEFAULT_WORKSPACE_STATUS = "requested";

// WorkspaceActivity describes the latest activity the workspace's agent runner reported.
export type WorkspaceActivity = "active" | "blocked" | "idle" | "unknown";

// mapActivity translates a runner's status into the four states the controller reports.
//
// Here, in the domain, because three places need it and two of them write into the same cache
// entry: the observation pass, the stream route, and the browser hook that corrects an optimistic
// guess. It lived in the service module and was copied by hand into the hook, which meant two
// spellings of "blocked" one import away from disagreeing — and the controls that gate on it
// flickering when they did.
//
// "done" is still accepted alongside "idle" because Herdr used to report both and a database
// restored from that era can hold either; they meant the same thing. "unknown" is passed through
// rather than flattened into idle, which is the rule the reaper depends on: a status nobody could
// read is not evidence that anything finished.
export function mapActivity(status: string): WorkspaceActivity {
	switch (status) {
		case "working":
			return "active";
		case "blocked":
			return "blocked";
		case "done":
		case "idle":
			return "idle";
		default:
			return "unknown";
	}
}

// WorkspaceStatus describes the controller-observed provisioning lifecycle.
export type WorkspaceStatus =
	| "booting"
	| "bootstrapping"
	| "destroyed"
	| "destroying"
	| "failed"
	| "provisioning"
	| "ready"
	| "registering"
	| "requested";

// ProvisionPhase is how far provisioning has progressed.
//
// Separate from current_step for the same reason as DestroyPhase: a step is prose for an
// operator, and a state machine that branches on prose cannot be checked. The phase also
// disambiguates current_task_upid, which is one column shared by every task the workspace has
// outstanding — without it, a start task and a clone task look identical.
export type ProvisionPhase =
	| "addressed"
	| "booted"
	| "bootstrapped"
	| "briefed"
	| "checked-out"
	| "clone-confirmed"
	| "clone-submitted"
	| "reachable"
	| "runner-started"
	| "seeded"
	| "start-submitted";

// DestroyPhase is how far teardown has progressed.
//
// Separate from current_step, which is prose for an operator. Encoding the state machine in
// sentences meant a branch compared progress against a human-readable string, and adding a phase
// could not be checked. "shutdown-tried" covers a shutdown that succeeded without stopping the
// guest as well as one that failed: both mean the next action is a forced stop.
export type DestroyPhase =
	| "delete-submitted"
	| "shutdown-submitted"
	| "shutdown-tried"
	| "stop-submitted";

// WorkspaceTarget describes the desired durable lifecycle state.
export type WorkspaceTarget = "destroyed" | "present";

// WorkspaceTransitionError explains why a requested state transition is invalid.
export type WorkspaceTransitionError = {
	from: WorkspaceStatus;
	message: string;
	to: WorkspaceStatus;
};

// WorkspaceTransitionResult is the result of attempting a state transition.
export type WorkspaceTransitionResult =
	| { ok: true; status: WorkspaceStatus }
	| { error: WorkspaceTransitionError; ok: false };

// nextWorkspaceStatus validates and returns the requested lifecycle transition.
export function nextWorkspaceStatus(
	from: WorkspaceStatus,
	to: WorkspaceStatus,
): WorkspaceTransitionResult {
	if (from === to) {
		return { ok: true, status: to };
	}

	if (to === "destroying" && from !== "destroyed") {
		return { ok: true, status: to };
	}

	if (to === "failed" && from !== "destroyed" && from !== "destroying") {
		return { ok: true, status: to };
	}

	if (from === "requested" && to === "provisioning") {
		return { ok: true, status: to };
	}

	if (from === "provisioning" && to === "booting") {
		return { ok: true, status: to };
	}

	if (from === "booting" && to === "bootstrapping") {
		return { ok: true, status: to };
	}

	if (from === "bootstrapping" && to === "registering") {
		return { ok: true, status: to };
	}

	if (from === "registering" && to === "ready") {
		return { ok: true, status: to };
	}

	if (from === "destroying" && to === "destroyed") {
		return { ok: true, status: to };
	}

	if (from === "failed" && to === "provisioning") {
		return { ok: true, status: to };
	}

	return {
		error: {
			from,
			message: `workspace: cannot transition from ${from} to ${to}`,
			to,
		},
		ok: false,
	};
}

// workspaceTargetForStatus returns the desired state implied by a destruction transition.
export function workspaceTargetForStatus(
	status: WorkspaceStatus,
): WorkspaceTarget {
	if (status === "destroyed" || status === "destroying") {
		return "destroyed";
	}

	return "present";
}
