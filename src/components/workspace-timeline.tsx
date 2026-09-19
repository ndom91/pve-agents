type TimelineEvent = {
	createdAt: string;
	eventType: string;
	id: number;
	message: string;
};

// WorkspaceTimeline renders a workspace's history, oldest first.
//
// Laid out as a timeline rather than a table: a marked rule down the left, and each entry giving
// its name and time on one line with the message under them. The table shape it had needed a
// fixed-width column for the type, which in a rail meant every message was cut off or wrapped
// against an arbitrary edge.
export function WorkspaceTimeline({ events }: { events: TimelineEvent[] }) {
	if (events.length === 0) {
		return <p className="detail-note">Nothing has happened yet.</p>;
	}

	return (
		<ol className="detail-timeline">
			{events.map((event) => {
				const problem = isProblem(event.eventType);

				return (
					<li
						className={problem ? "timeline-entry is-problem" : "timeline-entry"}
						key={event.id}
					>
						{/* The rule and its marker. Decoration, so it is not announced: the entry
						    already reads as a name, a time and a message without it. */}
						<span aria-hidden className="timeline-mark" />
						<div className="timeline-body">
							<div className="timeline-head">
								<span className="timeline-type">
									{event.eventType.replace("workspace.", "").replace(/_/g, " ")}
								</span>
								<time dateTime={event.createdAt}>
									{event.createdAt.slice(11, 19)}
								</time>
							</div>
							<p className="timeline-message">{event.message}</p>
						</div>
					</li>
				);
			})}
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
