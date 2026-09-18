// AGENT_CWD is where the agent works inside a workspace.
//
// Shared because two passes need to agree on it: provisioning creates it and checks out into it,
// and the reaper looks there for work nobody kept. A second copy of this string would be a way for
// those two to disagree silently.
export const AGENT_CWD = "/workspace/repo";
