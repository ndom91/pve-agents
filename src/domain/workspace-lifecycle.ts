import type { ProvisionPhase } from "./workspace";

// LIFECYCLE_STEPS is the six-segment strip a provisioning workspace is read against.
//
// Six, against the eleven phases the provisioner actually walks. That is the point: the phases are
// a state machine and they are named for what the executor does next, which is the right
// vocabulary for the executor and the wrong one for somebody watching a bar fill. "clone-submitted"
// and "clone-confirmed" are two states because one of them is waiting on a Proxmox task; to a
// reader they are both "cloning".
export const LIFECYCLE_STEPS = [
	"requested",
	"cloned",
	"booted",
	"reachable",
	"seeded",
	"ready",
] as const;

// REACHED maps each provision phase to how many of those six are behind it.
//
// Taken from the switch in `workspace-provision-executor.ts`, which runs
// clone-submitted -> clone-confirmed -> start-submitted -> booted -> addressed -> reachable ->
// bootstrapped -> checked-out -> seeded -> runner-started -> briefed. A phase means "this is done,
// the next thing is what happens now", so each one counts the segment it completed.
//
// Keyed by the union rather than by `string`, so the compiler refuses to build when the executor
// gains a phase this does not place. As a Record<string, number> it fell through to the `?? 1`
// below and the strip quietly showed "requested" for a workspace that was nearly ready -- no error,
// no failing test, just a bar that had stopped being true.
const REACHED: Record<ProvisionPhase, number> = {
	addressed: 3,
	"clone-submitted": 1,
	"clone-confirmed": 2,
	"start-submitted": 2,
	booted: 3,
	reachable: 4,
	bootstrapped: 4,
	"checked-out": 4,
	seeded: 5,
	"runner-started": 5,
	briefed: 6,
};

// PROVISIONING is the set of statuses a workspace passes through on its way up.
//
// Exported so the strip's callers can ask "is this still being built" positively, rather than
// inferring it from `lifecycleReached(...) < 6`. That inference was wrong at the other end: the
// function returns 0 for a destroyed container on purpose, and 0 is also less than 6 -- so a
// workspace being torn down grew an empty six-segment progress bar announcing itself as
// "Provisioning: 0 of 6".
const PROVISIONING = new Set([
	"booting",
	"bootstrapping",
	"provisioning",
	"registering",
	"requested",
]);

// isProvisioning reports whether there is progress worth drawing.
//
// A failed workspace is excluded as well as a destroyed one: its bar would sit half-filled for
// ever, describing a climb that has stopped.
export function isProvisioning(status?: string): boolean {
	return status !== undefined && PROVISIONING.has(status);
}

// lifecycleReached is how many of the six segments are filled.
//
// Status wins over phase at both ends. A ready workspace is complete whatever its last recorded
// phase was -- an older row may carry no phase at all -- and a destroyed one is not mid-provision,
// it is over.
//
// A phase this does not place counts as requested rather than as nothing: it exists, which is the
// first segment. The `?? 1` looks unreachable now that the map is keyed by the union, and it is not:
// the type describes what this controller writes, and the value comes out of SQLite, which will
// hand back whatever a newer controller put there. A column read across a version boundary is
// exactly the case the fallback is for.
export function lifecycleReached(
	phase?: ProvisionPhase,
	status?: string,
): number {
	if (status === "ready") {
		return LIFECYCLE_STEPS.length;
	}
	if (status === "destroyed" || status === "destroying") {
		return 0;
	}
	if (phase === undefined) {
		return 1;
	}

	return REACHED[phase] ?? 1;
}
