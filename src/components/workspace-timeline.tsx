import { type ReactNode, useMemo } from "react";
import type { TimelineEvent } from "../domain/workspace-timeline";
import { groupTimeline } from "../domain/workspace-timeline";
import { formatDuration } from "../lib/clock";
import { Timestamp } from "./timestamp";

// WorkspaceTimeline renders a workspace's history, oldest first.
//
// A rail with a dot per moment, and between the dots the gap since the last one. The gaps are the
// change: a flat column of timestamps makes you subtract in your head, and what anybody actually
// wants from this tab is which step took the time.
//
// Prompts are filtered out: the chat already shows each one in full, so the row here was the same
// sentence truncated to 160 characters, and a long conversation buried the failures under them.
// Filtered rather than not recorded, because a destroyed workspace loses its transcript and keeps
// its timeline.
export function WorkspaceTimeline({
	events,
	readyIn,
}: {
	events: TimelineEvent[];
	// How long provisioning took, for the header. Absent on a workspace that never got there.
	readyIn?: string;
}): ReactNode {
	// Both memoised. An opened panel stays mounted so the terminal's socket survives a glance at
	// another tab, which means this keeps re-rendering with the rest of the page -- once per
	// streamed token while an agent is answering. Filtering and grouping a few hundred events at
	// that rate is work nobody asked for, and the result is identical every time.
	const shown = useMemo(
		() => events.filter((event) => event.eventType !== "workspace.prompted"),
		[events],
	);
	const items = useMemo(() => groupTimeline(shown), [shown]);

	if (shown.length === 0) {
		return <p className="detail-note">Nothing has happened yet.</p>;
	}

	return (
		<div className="timeline">
			{/* How much there is, and the one number that summarises it. */}
			<div className="panel-bar">
				<span className="timeline-count">
					{shown.length === 1 ? "1 event" : `${shown.length} events`}
				</span>
				<span className="spacer" />
				{readyIn === undefined ? null : (
					<>
						<span className="timeline-bar-key">Ready in</span>
						<span className="timeline-bar-value">{readyIn}</span>
					</>
				)}
			</div>

			<div className="timeline-scroll">
				<ol className="timeline-rail">
					{items.map((item) => (
						<li className="timeline-item" key={item.lead.id}>
							{/* The gap since the previous moment, on the rail between the two dots.
							    Not rendered for the first, which has nothing to be measured from,
							    and not for anything under a second: two moments 200ms apart land
							    in different seconds often enough, and "+0s" is a row of noise
							    claiming a wait that did not happen. */}
							{item.sincePrevious === undefined ||
							item.sincePrevious < 1000 ? null : (
								<div className="timeline-gap">
									<span aria-hidden="true" className="timeline-gap-tick" />
									<span className="timeline-gap-value">
										+{formatDuration(item.sincePrevious)}
									</span>
								</div>
							)}

							<div
								className={
									isProblem(item.lead.eventType)
										? "timeline-moment is-problem"
										: "timeline-moment"
								}
							>
								{/* Decoration: the moment already reads as a name, a time and a
								    message without a dot being announced beside it. */}
								<span aria-hidden="true" className="timeline-dot" />
								<div className="timeline-head">
									<span className="timeline-type">{label(item.lead)}</span>
									<span className="timeline-at">
										<Timestamp iso={item.lead.createdAt} of="time" />
									</span>
								</div>
								<p className="timeline-message">{item.lead.message}</p>

								{/* Everything else that landed in the same second, without
								    repeating the second. */}
								{item.nested.length === 0 ? null : (
									<ul className="timeline-nest">
										{item.nested.map((event) => (
											<li className="timeline-nest-row" key={event.id}>
												<span
													aria-hidden="true"
													className="timeline-nest-dot"
												/>
												<span className="timeline-nest-text">
													{event.message}
												</span>
											</li>
										))}
									</ul>
								)}
							</div>
						</li>
					))}
				</ol>
			</div>
		</div>
	);
}

// label is the event's type as a heading: "workspace.clone_confirmed" becomes "clone confirmed".
function label(event: TimelineEvent): string {
	return event.eventType.replace("workspace.", "").replace(/_/g, " ");
}

// isProblem marks the moments worth spotting in a long list: a retry, a failure, a halt.
function isProblem(eventType: string): boolean {
	return (
		eventType.includes("failed") ||
		eventType.includes("retrying") ||
		eventType.includes("halted")
	);
}
