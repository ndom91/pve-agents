import { elapsedBetween } from "../lib/clock";

// TimelineEvent is one row of a workspace's history.
export type TimelineEvent = {
	createdAt: string;
	eventType: string;
	id: number;
	message: string;
};

// TimelineItem is one moment on the rail: a lead event, whatever else happened in the same second,
// and how long it was since the previous moment.
export type TimelineItem = {
	lead: TimelineEvent;
	// Events sharing the lead's second. Rendered as a nested strip under it rather than as rows of
	// their own, because four entries repeating one timestamp is four copies of the same fact.
	nested: TimelineEvent[];
	// Milliseconds since the previous lead, or undefined for the first. This is what somebody
	// actually wants from a timeline: not when each thing happened, but how long it took after the
	// last one.
	sincePrevious?: number;
};

// groupTimeline turns a flat list of events into the moments the rail draws.
//
// Two things happen here. Events landing in the same second collapse into one moment, because
// provisioning writes several at once -- addressed, reachable, bootstrapped and checked-out all
// land together -- and as five separate rows they read as five separate waits that each took no
// time. And every moment after the first carries the gap since the one before it, which is the
// question a timeline is opened to answer.
//
// Same second rather than same millisecond: these are written by separate statements inside one
// pass, so they differ by single-digit milliseconds that mean nothing to anybody. Seconds are also
// the resolution the row actually prints, so grouping any finer would nest events that display an
// identical time.
export function groupTimeline(events: TimelineEvent[]): TimelineItem[] {
	const items: TimelineItem[] = [];

	for (const event of events) {
		const previous = items.at(-1);
		if (previous !== undefined && sameSecond(previous.lead, event)) {
			previous.nested.push(event);
			continue;
		}

		items.push({
			lead: event,
			nested: [],
			sincePrevious:
				previous === undefined
					? undefined
					: elapsedBetween(previous.lead.createdAt, event.createdAt),
		});
	}

	return items;
}

// sameSecond reports whether two events would print the same time.
//
// Unparseable stamps are never the same as anything, including each other. Grouping on a value
// neither of them could read would nest two events for no reason a reader could see.
function sameSecond(a: TimelineEvent, b: TimelineEvent): boolean {
	const left = second(a.createdAt);
	const right = second(b.createdAt);

	return left !== undefined && left === right;
}

function second(iso: string): number | undefined {
	const at = Date.parse(iso);

	return Number.isNaN(at) ? undefined : Math.floor(at / 1000);
}
