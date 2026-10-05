import { spawn } from "node:child_process";

import { knownHostsPath, type SshTarget } from "./ssh";

// Publishing a container's loopback port on the controller. A listener on 0.0.0.0 needs none of
// this: the workspace subnet already routes from the operator's machine.

// The range the controller allocates from, well clear of anything a person would pick by hand.
const FIRST = 20_000;
const LAST = 29_999;

// Forward is one published port.
export type Forward = {
  // The port on the controller. Allocated rather than mirrored, because two workspaces can both
  // be running Vite on 5173.
  allocated: number;
  port: number;
  workspaceId: string;
};

type Entry = Forward & { stop: () => void };

// In memory rather than a table: a forward is a child of this process and dies with it, so a
// record that outlived a restart would describe tunnels that no longer exist.
const FORWARDS = new Map<string, Entry>();

function key(workspaceId: string, port: number): string {
  return `${workspaceId}:${port}`;
}

function published({ allocated, port, workspaceId }: Entry): Forward {
  return { allocated, port, workspaceId };
}

// forwardsFor lists what is currently published for one workspace.
export function forwardsFor(workspaceId: string): Forward[] {
  return [...FORWARDS.values()]
    .filter((entry) => entry.workspaceId === workspaceId)
    .map(published);
}

// allocate finds the lowest free controller port, so the numbers a person sees stay small.
function allocate(): number | undefined {
  const taken = new Set([...FORWARDS.values()].map((entry) => entry.allocated));
  for (let port = FIRST; port <= LAST; port += 1) {
    if (!taken.has(port)) {
      return port;
    }
  }

  return undefined;
}

// startForward publishes one container port on the controller.
//
// Idempotent: a second call returns the running forward. Starting another against the same pair
// would fail to bind and look like the first one breaking.
//
// Binding 0.0.0.0 publishes a dev server to the network with nothing in front of it, which is why
// this is an explicit act with a Stop button rather than something the tab does on open.
export function startForward(
  workspaceId: string,
  target: SshTarget,
  port: number,
  // The address the listener bound, as `ss` prints it: "127.0.0.1" or "[::1]". Not a constant,
  // because Vite binds [::1] by default and a tunnel to 127.0.0.1 reaches nothing.
  bind: string,
): Forward | { message: string } {
  const existing = FORWARDS.get(key(workspaceId, port));
  if (existing !== undefined) {
    return published(existing);
  }

  const allocated = allocate();
  if (allocated === undefined) {
    return { message: "no free port to forward to" };
  }

  const ssh = spawn(
    "ssh",
    [
      "-i",
      target.keyPath,
      "-N",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      `UserKnownHostsFile=${knownHostsPath(target.keyPath)}`,
      "-o",
      "LogLevel=ERROR",
      "-L",
      `0.0.0.0:${allocated}:${bind}:${port}`,
      `${target.user}@${target.address}`,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );

  // Forgotten however it dies, so a dead tunnel is never offered as a link and its port is freed.
  const forget = () => {
    FORWARDS.delete(key(workspaceId, port));
  };
  ssh.on("exit", forget);
  ssh.on("error", forget);
  ssh.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`forward ${workspaceId}:${port}: ${String(chunk)}`);
  });

  FORWARDS.set(key(workspaceId, port), {
    allocated,
    port,
    stop: () => {
      if (!ssh.killed) {
        ssh.kill("SIGTERM");
      }
    },
    workspaceId,
  });

  return { allocated, port, workspaceId };
}

// stopForward takes one down.
export function stopForward(workspaceId: string, port: number): void {
  const entry = FORWARDS.get(key(workspaceId, port));
  entry?.stop();
  FORWARDS.delete(key(workspaceId, port));
}

// stopWorkspaceForwards takes down everything published for one workspace, on destroy.
export function stopWorkspaceForwards(workspaceId: string): void {
  for (const entry of FORWARDS.values()) {
    if (entry.workspaceId === workspaceId) {
      stopForward(workspaceId, entry.port);
    }
  }
}
