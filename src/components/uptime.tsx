import type { ReactNode } from "react";

import { Elapsed } from "./elapsed";

// Uptime is how long a container has been up.
//
// Counted from ready_at rather than created_at, because "up" means reachable and the gap between
// the two is the provision. Before a workspace is ready there is no uptime to report, so it says
// how long it has been waiting instead -- which is the number you actually want while you are
// watching one build.
//
// Nothing at all once it is gone. A destroyed container's uptime is a number that stopped being
// true, and a band that keeps counting is a band that is lying. That rule is the reason this is a
// component: the meta band had it and the rail's own copy did not, so the same workspace stopped
// counting in one place and kept going in the other.
export function Uptime({
	workspace,
}: {
	workspace: { createdAt?: string; readyAt?: string; status?: string };
}): ReactNode {
	if (workspace.status === "destroyed" || workspace.status === "destroying") {
		return null;
	}

	if (workspace.readyAt !== undefined) {
		return (
			<>
				up <Elapsed of="uptime" since={workspace.readyAt} />
			</>
		);
	}

	return (
		<>
			waiting <Elapsed of="uptime" since={workspace.createdAt} />
		</>
	);
}
