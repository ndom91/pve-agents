type TimelineEvent = {
	createdAt: string;
	eventType: string;
	id: number;
	message: string;
};

// WorkspaceTimeline renders a workspace's history, newest last.
export function WorkspaceTimeline({ events }: { events: TimelineEvent[] }) {
	if (events.length === 0) {
		return <p className="detail-note">Nothing has happened yet.</p>;
	}

	return (
		<ol className="detail-timeline">
			{events.map((event) => (
				<li
					className={isProblem(event.eventType) ? "log-problem" : undefined}
					key={event.id}
				>
					<time dateTime={event.createdAt}>
						{event.createdAt.slice(11, 19)}
					</time>
					<span className="log-type">
						{event.eventType.replace("workspace.", "")}
					</span>
					<span>{event.message}</span>
				</li>
			))}
		</ol>
	);
}

// isProblem marks the entries worth spotting in a long list: a retry, a failure, a halt.
function isProblem(eventType: string): boolean {
	return (
		eventType.includes("failed") ||
		eventType.includes("retrying") ||
		eventType.includes("halted")
	);
}
