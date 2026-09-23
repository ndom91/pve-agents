import type { TranscriptEntry } from "./transcript";

// A coding agent this controller can drive, and everything about it that is not the same as every
// other one.
//
// The protocol between the controller and a workspace is already neutral -- attach, snapshot,
// prompt, decide, interrupt out; snapshot, message, approval, resolved, status, fatal back -- and
// so is the transport that carries it. What was not neutral was scattered: an SDK import in the
// runner, Anthropic content blocks parsed in the browser, `~/.claude.json` in the provisioner, a
// `WORKSPACE_CLAUDE_OAUTH_TOKEN` in the config, and a merge rule in the seed service that named one
// file. This is where those live now.
//
// Deliberately not an abstraction over the agent. It is a description of the five things this
// controller has to know that differ, found by taking Claude Code out rather than by imagining
// what a harness might need -- so it is short, and the next one will probably lengthen it.
export type Harness = {
	// A file written into the workspace during bootstrap, so the agent starts without a human.
	//
	// Claude Code has two first-run gates behind one JSON file; another harness may have none, or
	// four files. A list rather than a single blob because "what does this write" is a question
	// with a list-shaped answer.
	bootstrap(cwd: string): HarnessFile[];
	// The credential, and how it reaches the workspace.
	//
	// `env` is the shell variable the agent itself reads -- not the controller's config key, which
	// is the same for every harness. Written into ~/.config/agent-env, which the runner sources.
	credential: { env: string };
	// Whether a seeded file is merged into what is already there rather than written over it.
	//
	// The one case today is Claude's ~/.claude.json, which the workspace writes itself during
	// bootstrap: seeding over it takes away the flags that let the agent start at all. A harness
	// with no such file says no to everything, which is the honest default.
	merges(homeRelativePath: string): boolean;
	name: string;
	// The runner shipped into the workspace, by filename under runner/.
	//
	// It is the only part that talks to the agent's own API, and therefore the part a new harness is
	// mostly made of. `entry` is what node is told to run; `also` are the files it imports.
	//
	// A list because the socket half is shared: agent-socket.mjs is imported relatively by every
	// runner, which works only because these are copied into one directory and there is no build
	// step to flatten them. A harness that needs nothing beyond its entry leaves `also` empty.
	runner: { also: string[]; entry: string };
	// What the agent said, as rows a person reads.
	//
	// The runner forwards its agent's messages untouched -- it should not decide what matters --
	// so this is where a harness's wire format stops and `TranscriptEntry` starts. Everything above
	// this line is the same for every harness.
	readTranscript(
		messages: unknown[],
		pending: { toolUseId?: string }[],
	): TranscriptEntry[];
};

// HarnessFile is one file a harness needs in a workspace before its agent will start.
export type HarnessFile = { contents: string; path: string };

// MergeRule is the merge question on its own, for the seeding path that only asks that.
//
// Narrow deliberately: seeding takes this rather than a whole Harness so its tests can pass a rule
// and nothing else, which is what keeps them from being written around claude-code. A name for the
// shape rather than four copies of it.
export type MergeRule = Pick<Harness, "merges">;

const REGISTRY = new Map<string, Harness>();

// register makes a harness selectable by name.
//
// A registry rather than a union, so adding one is adding a file rather than editing a type that
// every consumer then has to be re-checked against.
export function register(harness: Harness): void {
	REGISTRY.set(harness.name, harness);
}

// harness resolves a configured name, or throws.
//
// Throws rather than falling back to the default. A controller configured for a harness that does
// not exist has been misconfigured, and quietly running a different agent than the one asked for is
// the worst available answer -- it would look like it worked.
export function harness(name: string): Harness {
	const found = REGISTRY.get(name);
	if (found === undefined) {
		throw new Error(
			`unknown agent harness "${name}"; registered: ${[...REGISTRY.keys()].sort().join(", ")}`,
		);
	}

	return found;
}

// harnessNames lists what is registered, for the config's own error message.
export function harnessNames(): string[] {
	return [...REGISTRY.keys()].sort();
}
