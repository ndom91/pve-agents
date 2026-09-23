// What the controller and a workspace's agent runner say to each other.
//
// Both halves of this protocol were written out as bare object literals in five files: the
// transport, the SSE route, the browser hook, the probe CLI, and the runner itself. Nothing failed
// at build time when a field was renamed on one side — the other simply started reading undefined,
// which on this wire means "the agent looks idle" or "there is no approval waiting".
//
// So the shapes live here, in the domain, where the server, the browser and the CLI can all import
// them. `runner/agent-runner.mjs` is the one place that cannot: it is plain JavaScript shipped to a
// container as a single file with no build step, deliberately. Its header points here instead.
// That makes the coupling visible rather than removing it, which is the honest outcome.

// RunnerRequest is everything the controller sends.
export type RunnerRequest =
	// Subscribes: the snapshot, then every event as it happens. What an open page holds.
	| { type: "attach" }
	// The same reply, one-shot: the runner closes the connection after sending it.
	//
	// Separate from "attach" because a subscriber receives broadcasts from the moment it connects.
	// A caller that sends a prompt and asks for a snapshot behind it can have the status broadcast
	// for its own prompt arrive first, so "the first line back" is not the reply.
	| { type: "snapshot" }
	| { behavior: "allow" | "deny"; id: string; type: "decide" }
	| { text: string; type: "prompt" }
	| { type: "interrupt" };

// ApprovalRequest is one tool call the agent is suspended on.
//
// `title`, `displayName` and `decisionReason` are composed by the SDK's own bridge — "Claude wants
// to read foo.txt" — and forwarded rather than rebuilt, because rebuilding them means writing a
// renderer per tool and getting it quietly wrong for the ones nobody tested.
export type ApprovalRequest = {
	blockedPath?: string;
	decisionReason?: string;
	displayName?: string;
	id: string;
	input: Record<string, unknown>;
	title?: string;
	toolName: string;
	// The tool_use block this call belongs to, so the UI can mark the row that is actually waiting
	// rather than the most recent one with a matching name.
	toolUseId?: string;
};

// RunnerStatus is what the runner says its agent is doing.
//
// "blocked" is asserted rather than inferred: it means a callback is genuinely suspended waiting
// for a person. The reaper refuses to destroy a blocked agent, so the word carries real weight.
export type RunnerStatus = "blocked" | "idle" | "working";

// RunnerSnapshot is the runner's whole truth, sent in reply to an attach.
//
// A replacement rather than a delta, and it arrives again on every reconnection — merging one
// would double the transcript each time a connection blipped.
export type RunnerSnapshot = {
	approvals: ApprovalRequest[];
	cwd: string;
	// Which agent produced the messages below, so the page knows how to read them.
	//
	// From the runner rather than from the controller's config, and that is the point: a workspace
	// provisioned under one harness keeps being read by that one after the config changes. Absent
	// on a runner installed before this shipped, which the controller reads as claude-code because
	// that is the only thing those runners ever were.
	harness?: string;
	// Every message except the partials. Kept as `unknown` because these are the SDK's own union,
	// whose thirty-eight members would put the SDK into the browser bundle to describe five fields.
	messages: unknown[];
	permissionMode: string;
	sessionId?: string;
	status: RunnerStatus;
	// What the agent called this piece of work, once it has been asked. Absent on a runner
	// installed before naming shipped, and absent when the naming call failed -- both of which the
	// controller shows as no title rather than as an error.
	title?: string;
	type: "snapshot";
};

// RunnerEvent is everything the runner says.
//
// `detached` is the one member the runner never sends: the SSE route synthesises it when the
// connection dies, so a page can say the agent is gone rather than merely looking quiet.
export type RunnerEvent =
	| RunnerSnapshot
	| { approval: ApprovalRequest; type: "approval" }
	| { id: string; type: "resolved" }
	| { message: unknown; type: "message" }
	| { message: string; type: "fatal" }
	| { status: RunnerStatus | "ended"; type: "status" }
	| { type: "detached" };

// readEvent narrows one parsed line to an event, or nothing.
//
// A single place to reject what does not belong, so three separate readers do not each cast their
// way through the same object. Unknown types are dropped rather than thrown on: the runner is a
// separate deployable and a newer one may say things this controller has no opinion about.
export function readEvent(value: unknown): RunnerEvent | undefined {
	if (typeof value !== "object" || value === null) {
		return undefined;
	}

	const event = value as { type?: unknown };
	switch (event.type) {
		case "approval":
		case "detached":
		case "fatal":
		case "message":
		case "resolved":
		case "snapshot":
		case "status":
			return value as RunnerEvent;
		default:
			return undefined;
	}
}
