import { describe, expect, it } from "vitest";

import type { SshResult, SshRunner, SshTarget } from "./ssh";
import { listeningPorts } from "./workspace-ports";

const TARGET: SshTarget = {
  address: "10.0.3.100",
  keyPath: "/var/lib/controller/ssh/id",
  user: "agent",
};

function recorder(result: SshResult) {
  const calls: string[][] = [];
  const ssh: SshRunner = (_target, command) => {
    calls.push(command);

    return Promise.resolve(result);
  };

  return { calls, ssh };
}

function ran(stdout: string): SshResult {
  return { code: 0, kind: "ran", stderr: "", stdout };
}

// The exact bytes the script produced against a live workspace, sentinel and all.
const REAL = `LISTEN 0      4096         0.0.0.0:22   0.0.0.0:*
LISTEN 0      5            0.0.0.0:5173 0.0.0.0:* users:(("python3",pid=726,fd=3))
LISTEN 0      100        127.0.0.1:25   0.0.0.0:*
LISTEN 0      5          127.0.0.1:5174 0.0.0.0:* users:(("python3",pid=727,fd=3))
---CWD---
726\t/workspace/repo
727\t/workspace/repo
`;

describe("listeningPorts", () => {
  it("reads the listing and the directories out of one round trip", async () => {
    // One connection, not one per process. The alternative is an SSH per dev server to fill a
    // column, for somebody who opened a tab rather than asked a question.
    const { calls, ssh } = recorder(ran(REAL));

    const ports = await listeningPorts(TARGET, ssh);

    expect(calls).toHaveLength(1);
    expect(ports).toEqual({
      kind: "listed",
      ports: [
        {
          address: "0.0.0.0",
          cwd: "/workspace/repo",
          pid: 726,
          port: 5173,
          process: "python3",
          reach: "direct",
        },
        {
          address: "127.0.0.1",
          cwd: "/workspace/repo",
          pid: 727,
          port: 5174,
          process: "python3",
          reach: "loopback",
        },
      ],
    });
  });

  it("still lists ports when no directory could be read", async () => {
    // readlink fails for a process that exited between the two commands, and the loop carries
    // on. Losing a column is not losing the row.
    const { ssh } = recorder(
      ran(`LISTEN 0 5 0.0.0.0:5173 0.0.0.0:* users:(("python3",pid=726,fd=3))
---CWD---
`),
    );

    const ports = await listeningPorts(TARGET, ssh);

    expect(ports.kind === "listed" && ports.ports[0]).toMatchObject({
      cwd: undefined,
      port: 5173,
    });
  });

  it("keeps a directory containing a tab whole", async () => {
    // The pid is the part before the first tab and the path is everything after it, however
    // many tabs that is. Splitting on every tab would truncate the path at the first one.
    const { ssh } = recorder(
      ran(`LISTEN 0 5 0.0.0.0:5173 0.0.0.0:* users:(("node",pid=9,fd=3))
---CWD---
9\t/workspace/od\td\tname
`),
    );

    const ports = await listeningPorts(TARGET, ssh);

    expect(ports.kind === "listed" && ports.ports[0]?.cwd).toBe(
      "/workspace/od\td\tname",
    );
  });

  it("says a refused connection is unreachable rather than empty", async () => {
    // An empty list means "nothing is listening", which is a different thing from "we could not
    // ask" -- and the tab would show the first while meaning the second.
    const { ssh } = recorder({ kind: "refused" });

    expect(await listeningPorts(TARGET, ssh)).toEqual({
      kind: "unavailable",
      message: "the workspace is not reachable",
    });
  });

  it("carries the remote error rather than inventing one", async () => {
    const { ssh } = recorder({
      code: 127,
      kind: "ran",
      stderr: "ss: command not found",
      stdout: "",
    });

    expect(await listeningPorts(TARGET, ssh)).toEqual({
      kind: "unavailable",
      message: "ss: command not found",
    });
  });

  it("copes with the sentinel never arriving", async () => {
    // A truncated read, or an older script. The listing is still worth showing.
    const { ssh } = recorder(
      ran(`LISTEN 0 5 0.0.0.0:5173 0.0.0.0:* users:(("node",pid=9,fd=3))`),
    );

    const ports = await listeningPorts(TARGET, ssh);

    expect(ports.kind === "listed" && ports.ports).toHaveLength(1);
  });
});
