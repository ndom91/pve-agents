// DEFAULT_WORKSPACE_ACTIVITY is the initial observed agent activity for a new workspace.
export const DEFAULT_WORKSPACE_ACTIVITY = "unknown";

// DEFAULT_WORKSPACE_STATUS is the initial observed lifecycle status for a new workspace.
export const DEFAULT_WORKSPACE_STATUS = "requested";

// WorkspaceActivity describes the latest aggregate activity reported by Herdr.
export type WorkspaceActivity = "active" | "blocked" | "idle" | "unknown";

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
	| "agent-started"
	| "booted"
	| "bootstrapped"
	| "briefed"
	| "checked-out"
	| "clone-confirmed"
	| "clone-submitted"
	| "herdr-registered"
	| "reachable"
	| "runner-started"
	| "session-started"
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
