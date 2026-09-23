import type { Harness } from "../../domain/harness";
import { readOpencodeCredential } from "./credential";
import { readOpencodeTranscript } from "./transcript";

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
	// Read by the runner, not by opencode.
	//
	// Every provider integration does declare environment variables it reads for itself --
	// OPENAI_API_KEY, GROQ_API_KEY -- and if this only ever had to carry an API key, that would be
	// the whole mechanism and there would be no code. It has to carry an OAuth grant, which
	// opencode will accept from a device flow and from nothing else, so the runner writes it into
	// opencode's own credential table instead. See credential.ts.
	credential: { env: "OPENCODE_CREDENTIAL" },
	// Nothing. Merging exists to protect a file the workspace wrote for itself during bootstrap --
	// that is what makes ~/.claude.json a special case -- and opencode writes none: a provisioned
	// workspace has an empty ~/.config/opencode and no config file anywhere under $HOME.
	//
	// An earlier version of this merged .config/opencode/opencode.json, which was wrong twice. It
	// named one of the three files opencode actually reads (config.json, opencode.json,
	// opencode.jsonc), and merged destinations are validated with JSON.parse -- so a commented
	// opencode.jsonc, which is the entire reason that format exists, would have been refused.
	merges: () => false,
	name: "opencode2",
	readCredential: (value) => {
		const read = readOpencodeCredential(value);

		return read.kind === "read" ? { kind: "ok" } : read;
	},
	readTranscript: readOpencodeTranscript,
	runner: { also: ["agent-socket.mjs"], entry: "opencode2.mjs" },
};
