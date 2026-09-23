import type { Harness } from "../../domain/harness";
import { claudeSeed } from "./bootstrap";
import { readTranscript } from "./transcript";

// CLAUDE_JSON is the one destination that is merged into rather than written over.
//
// The workspace writes this file itself, before seeding runs: `bootstrap` puts the onboarding and
// trust-dialog flags in it, which is what lets the agent start without a human to answer two
// first-run prompts. A seeded copy landing on top of that would take those flags away and the agent
// would stall on a question nobody is there to see.
//
// mcpServers is the reason an operator seeds it at all: MCP configuration belongs in this file, and
// the alternative -- a .mcp.json in the checkout -- is a file that eventually gets committed to
// somebody's repository.
const CLAUDE_JSON = ".claude.json";

// Claude Code, driven through @anthropic-ai/claude-agent-sdk by runner/agent-runner.mjs.
//
// The first harness, and for now the only one that has a runner. Everything specific to it is
// either in this directory or named from here.
export const claudeCode: Harness = {
	bootstrap: (cwd) => [
		{ contents: claudeSeed(cwd), path: `$HOME/${CLAUDE_JSON}` },
	],
	// Not an API key. A long-lived OAuth token from `claude setup-token`, tied to a subscription.
	credential: { env: "CLAUDE_CODE_OAUTH_TOKEN" },
	merges: (path) => path.trim() === CLAUDE_JSON,
	name: "claude-code",
	readTranscript,
	runner: { also: ["agent-socket.mjs"], entry: "agent-runner.mjs" },
};
