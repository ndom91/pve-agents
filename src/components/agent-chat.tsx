import { ChevronRight } from "lucide-react";
import {
	type ReactNode,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";

import type { ThoughtEntry, ToolEntry } from "../domain/agent-feed";
import { countErrors, countTools, groupFeed } from "../domain/agent-feed";
import type { TranscriptEntry } from "../domain/transcript";
import { DEFAULT_HARNESS, harness } from "../harness";
import { elapsedBetween, formatStep } from "../lib/clock";
import { languageOfOutput, languageOfPath } from "../lib/highlight";
import type { AgentTail, Approval } from "../lib/use-agent-stream";
import { AgentProse } from "./agent-prose";
import { Button } from "./button";
import { CodeBlock } from "./code-block";
import { PanelSpinner } from "./panel-state";
import { Timestamp } from "./timestamp";

// AgentChat is the conversation, where the terminal used to be.
//
// Built by hand rather than from a chat library, and that was a decision rather than an oversight.
// The two candidates were Vercel's AI Elements, which is Tailwind-on-shadcn source copied into
// your repo — this application has no Tailwind and 1600 lines of its own CSS — and TanStack AI,
// whose UI layer ships no markup at all by design. What either would have contributed is a
// collapsible row, which `changes-accordion.tsx` beside this file already is.
//
// What was worth taking is the vocabulary: the tool states below are AI Elements', because it had
// already worked out the six facts a reader needs and a fifth spelling of them helps nobody.
export function AgentChat({
	approvals,
	busy,
	harness: name = DEFAULT_HARNESS,
	link,
	messages,
	onDecide,
	permissionMode,
	tail,
}: {
	approvals: Approval[];
	busy: boolean;
	// Which agent produced `messages`, from the snapshot. Its reader is what turns them into rows,
	// so this component never learns any agent's wire format.
	harness?: string;
	link: "attached" | "gone" | "opening";
	messages: unknown[];
	onDecide: (approvalId: string, behavior: "allow" | "deny") => void;
	permissionMode?: string;
	tail?: AgentTail;
}): ReactNode {
	// Memoised for the same reason the grouping below it is: this walks every message and every
	// content block in it, and a streamed answer re-renders this component per token. Without the
	// memo it also returns a new array each time, which would defeat the grouping's own memo.
	const entries = useMemo(
		() => harness(name).readTranscript(messages, approvals),
		[name, messages, approvals],
	);

	return (
		<div className="agent-chat">
			<Rail entries={entries} tail={tail} />

			{/* Below the transcript, not inside it. An approval is the newest thing that happened
			    and the only thing that needs an answer, so it sits where the eye lands last. */}
			{approvals.map((approval) => (
				<ApprovalCard
					approval={approval}
					busy={busy}
					key={approval.id}
					onDecide={onDecide}
					permissionMode={permissionMode}
				/>
			))}

			{link === "gone" ? (
				<p className="detail-note">
					The agent runner is no longer answering. Its session ended with it.
				</p>
			) : null}
			{/* The panel's spinner, like every other wait in the app. As a sentence it read as the
			    answer the page had settled on rather than as the moment before one. */}
			{link === "opening" && entries.length === 0 && tail === undefined ? (
				<PanelSpinner label="Attaching to the agent." />
			) : null}
			{link === "attached" && entries.length === 0 && tail === undefined ? (
				<p className="detail-note">
					Nothing has happened yet. Tell the agent what to do.
				</p>
			) : null}
		</div>
	);
}

// SLACK is how far from the bottom still counts as reading the end.
//
// A reader who has scrolled deliberately is usually hundreds of pixels up, so this only has to
// absorb the last line sitting a few pixels short of flush and the sub-pixel rounding a zoomed
// page produces. Generous enough and it stops being possible to stand just above the newest
// entry without being dragged down to it.
const SLACK = 24;

// Rail is the transcript itself, pinned to the bottom while it grows.
function Rail({
	entries,
	tail,
}: {
	entries: TranscriptEntry[];
	tail?: AgentTail;
}) {
	const list = useRef<HTMLOListElement>(null);
	// How tall the transcript was the last time this knew where the reader was.
	//
	// The whole mechanism, and the reason there is no longer a scroll listener deciding it. "Is
	// the reader at the bottom" cannot be answered after the content has grown — by then the
	// bottom has moved. Answering it against the height from before the growth can be done
	// synchronously, at the moment of the change, with nothing to race.
	const measured = useRef(0);

	// Follows a new entry and a growing tail, and only while the reader is already at the end.
	//
	// It used to read a `pinned` ref that a scroll handler wrote. That handler was the bug:
	// scroll events are delivered asynchronously, and during a stream a token arrives every few
	// milliseconds. Scrolling up put the event in the queue behind the next token, the effect
	// still saw the stale "at the bottom", and the reader was dragged back down by the thing they
	// had just scrolled away from. Measuring here instead closes the window entirely.
	//
	// The two lengths are triggers rather than values the body reads, which is what the rule
	// below objects to. Growth is the event; the size of it is measured from the DOM.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the lengths are the trigger, not an input
	useLayoutEffect(() => {
		const box = list.current;
		if (box === null) {
			return;
		}

		// Against the previous height, not the current one. Appending below does not move
		// scrollTop, so this asks where the reader was standing in the transcript as it was.
		// SLACK covers sub-pixel rounding and the last line being a few pixels short of flush.
		const followed =
			box.scrollTop + box.clientHeight >= measured.current - SLACK;
		if (followed) {
			// scrollTop rather than scrollIntoView: that scrolls every scrollable ancestor to
			// reveal the element, so on a short window it moved the page as well as the list.
			box.scrollTop = box.scrollHeight;
		}
		measured.current = box.scrollHeight;
	}, [entries.length, tail?.text.length]);

	// Memoised because the conversation re-renders on every streamed token, and the grouping walks
	// the whole transcript. Without this, an answer arriving one word at a time rebuilds every
	// group in the feed once per word -- and hands each one a fresh array, so nothing below can
	// skip its own work either.
	const items = useMemo(() => groupFeed(entries), [entries]);

	return (
		<ol
			className="chat-entries"
			// Nothing is decided here. It re-reads the height so that growth this effect never saw
			// — a tool fold opening, an image landing — cannot leave the stored height too small
			// and make the next append think the reader is at the bottom when they are not.
			onScroll={(event) => {
				measured.current = event.currentTarget.scrollHeight;
			}}
			ref={list}
		>
			{items.map((item, index) =>
				item.kind === "tools" ? (
					<li
						className="chat-entry is-tools"
						// The first row's id. Runs are never reordered, and the row that opens one
						// is the most stable thing about it.
						key={`tools-${item.rows[0].kind === "tool" ? item.rows[0].id : index}`}
					>
						<ToolGroup rows={item.rows} />
					</li>
				) : (
					<li
						className={`chat-entry is-${item.entry.kind}`}
						// Position is the only stable identity a text entry has: the same sentence
						// can legitimately appear twice, and entries are only ever appended.
						// biome-ignore lint/suspicious/noArrayIndexKey: position is the identity here
						key={`${item.entry.kind}-${index}`}
					>
						<Entry entry={item.entry} />
					</li>
				),
			)}
			{tail === undefined ? null : (
				<li className={`chat-entry is-${tail.kind} is-streaming`}>
					{tail.kind === "thought" ? (
						// Open while it is being written, then folded away by the transcript once it
						// lands. Thinking is worth watching and rarely worth re-reading.
						//
						// Shimmered while it holds. data-text carries the same string a second time
						// because the gradient is clipped to the glyphs of a ::before layer, which
						// has no access to the element's own text.
						<p
							className="chat-text chat-thinking t-shimmer"
							data-text={tail.text}
						>
							{tail.text}
						</p>
					) : (
						<AgentProse streaming text={tail.text} />
					)}
				</li>
			)}
		</ol>
	);
}

function Entry({ entry }: { entry: TranscriptEntry }) {
	if (entry.kind === "tool") {
		return <ToolRow entry={entry} />;
	}
	if (entry.kind === "thought") {
		return <Fold summary="Thought" text={entry.text} />;
	}

	if (entry.kind === "ended") {
		return <p className="chat-ended">The turn ended: {entry.reason}</p>;
	}

	// A prompt is shown as typed. It is the operator's own words, and rendering their asterisks as
	// emphasis would quietly change what they wrote.
	//
	// A caret in the gutter rather than a tinted block with an accent border. The block was the
	// loudest thing in the transcript and it was marking the shortest line in it; the caret says
	// the same thing in one glyph and lets the agent's answer be what the eye lands on.
	if (entry.kind === "prompt") {
		return (
			<div className="chat-turn">
				<span aria-hidden="true" className="chat-turn-caret">
					&rsaquo;
				</span>
				<div className="chat-turn-body">
					<p className="chat-text">{entry.text}</p>
					{entry.at === undefined ? null : (
						<span className="chat-turn-at">
							<Timestamp iso={entry.at} of="time" />
						</span>
					)}
				</div>
			</div>
		);
	}

	return <AgentProse at={entry.at} text={entry.text} />;
}

// ToolGroup is a run of agent activity in one bordered box.
//
// The biggest change to the feed. A transcript is mostly these, and as a flat column of chevrons
// they were the page -- the question above them and the answer below were two lines lost in
// fourteen. The box says "this is one piece of work", the header says how much of it there was,
// and the error count says whether any of it needs reading.
//
// Rows stay listed and their output stays folded. The group is a frame around them, not a second
// disclosure on top of one -- two nested things to open before you can read an error is exactly
// the friction this is removing.
function ToolGroup({ rows }: { rows: (ThoughtEntry | ToolEntry)[] }) {
	const calls = countTools(rows);
	const errors = countErrors(rows);

	return (
		<div className="tool-group">
			<div className="tool-group-head">
				<span className="tool-group-title">Tool calls</span>
				<span className="tool-group-count">{calls}</span>
				<span className="spacer" />
				{errors === 0 ? null : (
					<span className="tool-group-errors">
						<span aria-hidden="true" className="tool-group-dot" />
						{errors === 1 ? "1 error" : `${errors} errors`}
					</span>
				)}
			</div>
			{rows.map((row, index) => (
				<div
					className="tool-group-row"
					key={row.kind === "tool" ? row.id : `thought-${index}`}
				>
					{row.kind === "tool" ? (
						<ToolRow entry={row} />
					) : (
						<Fold summary="Thought" text={row.text} />
					)}
				</div>
			))}
		</div>
	);
}

// ToolRow is one tool call and, folded under it, what it returned.
//
// Collapsed by default because a transcript is mostly these, and a page that opens every result is
// a page of file contents with the reasoning lost between them.
function ToolRow({
	entry,
}: {
	entry: Extract<TranscriptEntry, { kind: "tool" }>;
}) {
	return (
		<Fold
			// How long the step took, or nothing. Nothing rather than a dash: a runner installed
			// before controller_at shipped stamps no times at all, and an empty column is the
			// truthful rendering of "never recorded" where an em dash reads as "measured, and
			// unmeasurable".
			duration={formatStep(
				elapsedBetween(entry.at, entry.endedAt) ?? Number.NaN,
			)}
			lang={languageOfResult(entry)}
			// Failures open on their own. A closed row saying "Error" asks the reader to go and
			// find out what went wrong; the reason is the entire content of that row.
			open={entry.state === "error"}
			state={entry.state}
			summary={`${entry.name} ${describe(entry.input)}`.trim()}
			text={entry.result ?? ""}
		/>
	);
}

// languageOfResult decides how to colour what a tool returned.
//
// A file read is the file's own language, which the path gives away. Anything else is guessed only
// where the guess is safe: a JSON body reads far better highlighted, and an `ls -la` listing or a
// test log is prose with punctuation in it that a highlighter turns into confetti.
function languageOfResult(
	entry: Extract<TranscriptEntry, { kind: "tool" }>,
): string {
	const path = entry.input.file_path ?? entry.input.path;
	if (typeof path === "string" && path !== "") {
		return languageOfPath(path);
	}

	return languageOfOutput(entry.result ?? "");
}

// Fold is the disclosure this page uses everywhere: a summary row, and content under it.
function Fold({
	duration,
	lang,
	open = false,
	state,
	summary,
	text,
}: {
	duration?: string;
	lang?: string;
	open?: boolean;
	state?: string;
	summary: string;
	text: string;
}) {
	const [shown, setShown] = useState(open);
	const empty = text.trim() === "";

	// `open` matters after the first render, not only at it.
	//
	// useState reads its argument once, so a row that arrives closed and is told to open later
	// never did. That is not an edge case here: a tool call streams in as "running" and only
	// becomes "error" when it finishes, so the failures this was written to open were the one
	// thing it could not open.
	//
	// One-way, deliberately. A reader who closes an errored row has read it, and `open` is still
	// true, so a two-way binding would reopen it on the next render.
	useEffect(() => {
		if (open) {
			setShown(true);
		}
	}, [open]);

	// Whether the panel is in the DOM at all, kept apart from whether it is open.
	//
	// A grid track cannot animate from 0fr to 1fr in the same frame its content first appears, so
	// the panel has to be mounted shut and opened afterwards. Mounting every fold shut from the
	// start would be simpler and much worse: a long transcript is dozens of tool results, and
	// every one of them would be highlighted on arrival for a panel nobody opened.
	const [mounted, setMounted] = useState(open);
	useEffect(() => {
		if (!shown) {
			return;
		}
		setMounted(true);
	}, [shown]);

	return (
		<div className="t-acc" data-open={mounted && shown && !empty}>
			<button
				aria-expanded={shown}
				className={state === undefined ? "chat-fold" : `chat-fold is-${state}`}
				// Nothing to unfold. Still a row, because the call happened and belongs in the
				// order of events, but not a control that does nothing when clicked.
				disabled={empty}
				onClick={() => setShown((was) => !was)}
				type="button"
			>
				<ChevronRight aria-hidden className="chat-caret" size={12} />
				<span className="chat-summary">{summary}</span>
				{state === undefined ? null : (
					<span className="chat-state">{label(state)}</span>
				)}
				{/* A fixed column whether or not there is a number in it, so the state words above
				    and below stay in line. */}
				{state === undefined ? null : (
					<span className="chat-took">{duration}</span>
				)}
			</button>
			{empty || !mounted ? null : (
				<div className="t-acc-panel">
					<div className="t-acc-panel-inner">
						<CodeBlock className="chat-output" code={text} lang={lang} />
					</div>
				</div>
			)}
		</div>
	);
}

// ApprovalCard is the question the whole control plane exists to ask.
function ApprovalCard({
	approval,
	busy,
	onDecide,
	permissionMode,
}: {
	approval: Approval;
	busy: boolean;
	onDecide: (approvalId: string, behavior: "allow" | "deny") => void;
	permissionMode?: string;
}) {
	// Revealed rather than simply appearing. This card is the one thing in the transcript that
	// stops and asks, and it arrives mid-scroll in a page that is otherwise always moving; a
	// staggered rise is what separates "something new needs you" from "more output".
	//
	// Shown one frame after mount, because the lines have to be painted in their pre-reveal state
	// before the class that moves them out of it lands.
	const [shown, setShown] = useState(false);
	useEffect(() => {
		const frame = requestAnimationFrame(() => setShown(true));
		return () => cancelAnimationFrame(frame);
	}, []);

	return (
		<div
			className={
				shown ? "chat-approval t-stagger is-shown" : "chat-approval t-stagger"
			}
		>
			{/* The runner composes this sentence itself — "Claude wants to read foo.txt" — so it is
			    shown rather than rebuilt from the tool name and its input. Rebuilding means writing
			    a renderer per tool and getting it quietly wrong for the ones nobody tested. */}
			<p className="chat-approval-title t-stagger-line t-stagger-line--1">
				{approval.title ?? `${approval.displayName ?? approval.toolName}`}
			</p>
			{approval.decisionReason === undefined ? null : (
				<p className="chat-approval-why t-stagger-line t-stagger-line--2">
					{approval.decisionReason}
				</p>
			)}
			<CodeBlock
				className="chat-output"
				code={JSON.stringify(approval.input, null, 2)}
				lang="json"
			/>
			<div className="chat-approval-actions">
				<Button
					disabled={busy}
					onClick={() => onDecide(approval.id, "allow")}
					type="button"
				>
					Allow
				</Button>
				{/* Quiet rather than red: the danger is on the other button, and a red Decline
				    teaches people to click Allow to make the red thing go away. Tertiary rather
				    than secondary because an outline here reads as a second accent button. */}
				<Button
					disabled={busy}
					onClick={() => onDecide(approval.id, "deny")}
					type="button"
					variant="tertiary"
				>
					Decline
				</Button>
			</div>
			{/* Only when it is not the mode that was asked for. Auto mode falls back to asking
			    about everything when it is unavailable, and without this the page just seems to
			    have become tediously cautious for no reason anybody can see. */}
			{permissionMode === "auto" ? (
				<p className="chat-approval-why">
					Auto mode asked about this one rather than deciding it.
				</p>
			) : null}
		</div>
	);
}

// describe reduces a tool's input to the part worth putting on a closed row.
//
// A path or a command, not the whole object: the object is what unfolding shows, and a summary
// wide enough to hold it is not a summary.
function describe(input: Record<string, unknown>): string {
	for (const key of ["file_path", "command", "path", "pattern", "url"]) {
		const value = input[key];
		if (typeof value === "string" && value !== "") {
			return value.length > 80 ? `${value.slice(0, 80)}…` : value;
		}
	}

	return "";
}

function label(state: string): string {
	switch (state) {
		case "awaiting-approval":
			return "waiting on you";
		case "denied":
			return "declined";
		case "error":
			return "error";
		case "ok":
			return "done";
		default:
			return "running";
	}
}
