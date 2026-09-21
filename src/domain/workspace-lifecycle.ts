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
const REACHED: Record<string, number> = {
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

// lifecycleReached is how many of the six segments are filled.
//
// Status wins over phase at both ends. A ready workspace is complete whatever its last recorded
// phase was -- an older row may carry no phase at all -- and a destroyed one is not mid-provision,
// it is over. Everything in between reads its phase, and a workspace that has one nobody recognises
// counts as requested rather than as nothing: it exists, which is the first segment.
export function lifecycleReached(phase?: string, status?: string): number {
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
