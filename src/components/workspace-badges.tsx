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
			<span className={`status status-${status}`}>{status}</span>
			{status === "ready" ? (
				<span className={`activity activity-${activity}`}>{activity}</span>
			) : null}
		</>
	);
}
