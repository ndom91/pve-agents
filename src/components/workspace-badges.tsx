import { SwapText } from "./swap-text";

// WorkspaceBadges shows a workspace's lifecycle status and, once it has an agent, what that agent
// is doing.
//
// Activity is deliberately absent before "ready": a workspace still being built has no agent, and
// showing "unknown" there reads as a problem rather than as nothing having happened yet.
export function WorkspaceBadges({
	activity,
	status,
}: {
	activity: string;
	status: string;
}) {
	return (
		<>
			{/* The word swaps rather than being replaced. A workspace walks through five statuses
			    on its way to ready, and each of them landing between two frames is why somebody
			    watching a provision sees a badge that was apparently always saying this. */}
			<span className={`status status-${status}`}>
				<SwapText value={status} />
			</span>
			{status === "ready" ? (
				<span className={`activity activity-${activity}`}>
					<SwapText value={activity} />
				</span>
			) : null}
		</>
	);
}
