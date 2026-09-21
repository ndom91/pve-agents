import type { ReactNode } from "react";

import type { ProvisionPhase } from "../domain/workspace";
import {
	LIFECYCLE_STEPS,
	lifecycleReached,
} from "../domain/workspace-lifecycle";

// LifecycleStrip is how far a workspace has got, as six segments.
//
// One row of six rather than a percentage or a spinner, because the question is "how far along",
// and six named steps answer it at a glance without anybody reading a label. The names are not
// drawn -- they are the accessible value, which is what a reader who cannot see the fill needs.
//
// One component, because it was two. The rail had this with its progressbar role and its labels;
// the fleet row had the same loop copied without them, reaching into the rail's own class names,
// so the home screen's strip was a row of unlabelled decorative spans while the identical strip in
// the panel was announced.
export function LifecycleStrip({
	phase,
	status,
}: {
	phase?: ProvisionPhase;
	status?: string;
}): ReactNode {
	const reached = lifecycleReached(phase, status);
	// Nothing reached means no step to name. `LIFECYCLE_STEPS[Math.max(0, -1)]` is "requested",
	// which announced a container that had got nowhere as having completed the first step.
	const step = reached === 0 ? undefined : LIFECYCLE_STEPS[reached - 1];

	return (
		<div
			aria-label={
				step === undefined
					? `Provisioning: not started, 0 of ${LIFECYCLE_STEPS.length}`
					: `Provisioning: ${reached} of ${LIFECYCLE_STEPS.length}, ${step}`
			}
			aria-valuemax={LIFECYCLE_STEPS.length}
			aria-valuemin={0}
			aria-valuenow={reached}
			className="lifecycle"
			role="progressbar"
		>
			{LIFECYCLE_STEPS.map((name, index) => (
				<span
					className={
						index < reached ? "lifecycle-seg is-done" : "lifecycle-seg"
					}
					key={name}
				/>
			))}
		</div>
	);
}
