import type { Harness } from "../../domain/harness";
import { readOpencodeTranscript } from "./transcript";

// OPENCODE_JSON is opencode's project configuration, and the one destination that is merged.
//
// Merged for the same reason claude-code merges ~/.claude.json: an operator seeding MCP servers or
// a model default should add to what is there rather than replace it. Unlike claude-code there is
// nothing the workspace writes into it first, so today the merge only protects an operator from
// their own second seed file -- but the rule belongs to the harness either way, and discovering it
// the day opencode starts writing the file would mean discovering it as a broken workspace.
const OPENCODE_JSON = ".config/opencode/opencode.json";

// opencode2, driven over its local HTTP API by runner/opencode2.mjs.
//
// The second harness, and the reason the first one was put behind an interface. Nothing it does
// resembles claude-code's mechanism: a server on loopback with a password on stdout and an event
// bus, rather than an in-process SDK with a suspended callback.
export const opencode2: Harness = {
	// Nothing. opencode has no first-run gate to skip -- no theme picker, no trust prompt -- so
	// there is no file to write before it will start unattended. The empty list is the honest
	// answer and not an omission; `prepareAgentWorkspace` writes whatever comes back, including
	// none.
	bootstrap: () => [],
	// An API key, unlike claude-code's OAuth token. opencode reads this variable itself: every
	// provider integration declares the environment variables it accepts, and this is Anthropic's.
	// A provider is chosen with WORKSPACE_AGENT_MODEL, and swapping to another one means swapping
	// this name with it.
	credential: { env: "ANTHROPIC_API_KEY" },
	merges: (path) => path.trim() === OPENCODE_JSON,
	name: "opencode2",
	readTranscript: readOpencodeTranscript,
	runner: { also: ["agent-socket.mjs"], entry: "opencode2.mjs" },
};
