import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

// A fake ssh rather than a real one. What is under test is the bookkeeping -- which port was
// handed out, what happens when a child dies, whether asking twice starts two tunnels -- and none
// of that needs a process, a network or a container.
//
// The spawned command is captured because the arguments are the other half of the contract: a
// forward that binds the wrong interface or connects to the wrong address is a bug this file
// cannot see any other way.
const spawned: string[][] = [];
const children: FakeChild[] = [];

class FakeChild extends EventEmitter {
	killed = false;
	stderr = new EventEmitter();
	kill(): boolean {
		this.killed = true;
		// A real child does not exit synchronously on kill, and the registry listens for exit
		// rather than assuming. Emitted here so the tests exercise that path rather than a
		// shortcut.
		this.emit("exit", 0);

		return true;
	}
}

vi.mock("node:child_process", () => ({
	spawn: (_command: string, args: string[]) => {
		spawned.push(args);
		const child = new FakeChild();
		children.push(child);

		return child;
	},
}));

import {
	forwardsFor,
	startForward,
	stopForward,
	stopWorkspaceForwards,
} from "./port-forward";
import type { SshTarget } from "./ssh";

const TARGET: SshTarget = {
	address: "10.0.3.100",
	keyPath: "/var/lib/controller/ssh/id",
	user: "agent",
};

// The registry is module state, so every test has to leave it empty for the next one.
afterEach(() => {
	stopWorkspaceForwards("w1");
	stopWorkspaceForwards("w2");
	spawned.length = 0;
	children.length = 0;
});

function argsOf(index: number): string {
	return (spawned[index] ?? []).join(" ");
}

describe("startForward", () => {
	it("allocates from the top of the range, not the container's port", () => {
		// 5173 in two workspaces cannot be 5173 twice on one controller, which is the whole reason
		// the controller side is allocated rather than mirrored.
		const first = startForward("w1", TARGET, 5173, "127.0.0.1");

		expect(first).toEqual({ allocated: 20_000, port: 5173, workspaceId: "w1" });
	});

	it("gives two workspaces on the same port different ones", () => {
		startForward("w1", TARGET, 5173, "127.0.0.1");
		const second = startForward("w2", TARGET, 5173, "127.0.0.1");

		expect(second).toMatchObject({ allocated: 20_001 });
	});

	it("binds every interface on this side and connects to the given one", () => {
		// 0.0.0.0 here is what makes it reachable from the operator's machine at all, and is why
		// this is an explicit act with a Stop button. The far side is whatever the listener bound.
		startForward("w1", TARGET, 5173, "127.0.0.1");

		expect(argsOf(0)).toContain("-L 0.0.0.0:20000:127.0.0.1:5173");
	});

	it("connects to IPv6 loopback when that is what is listening", () => {
		// The bug a real Vite server found: it binds [::1], and a tunnel hardcoded to 127.0.0.1
		// reached a port nothing was listening on. The brackets are ssh's own escaping and `ss`
		// already prints them.
		startForward("w1", TARGET, 5173, "[::1]");

		expect(argsOf(0)).toContain("-L 0.0.0.0:20000:[::1]:5173");
	});

	it("starts no command on the far side", () => {
		// -N. There is nothing to run; the tunnel is the entire point.
		startForward("w1", TARGET, 5173, "127.0.0.1");

		expect(spawned[0]).toContain("-N");
	});

	it("fails rather than binds when the forward cannot be set up", () => {
		// ExitOnForwardFailure, so a port already taken on this side kills the ssh instead of
		// leaving a connection open that forwards nothing.
		startForward("w1", TARGET, 5173, "127.0.0.1");

		expect(argsOf(0)).toContain("ExitOnForwardFailure=yes");
	});

	it("returns the running forward rather than starting a second", () => {
		// Two clicks on Forward is one tunnel. A second against the same pair would fail to bind
		// and, with ExitOnForwardFailure, would look like the first one breaking.
		const first = startForward("w1", TARGET, 5173, "127.0.0.1");
		const again = startForward("w1", TARGET, 5173, "127.0.0.1");

		expect(again).toEqual(first);
		expect(spawned).toHaveLength(1);
	});

	it("reuses a port freed by a forward that ended", () => {
		startForward("w1", TARGET, 5173, "127.0.0.1");
		stopForward("w1", 5173);

		expect(startForward("w1", TARGET, 8080, "127.0.0.1")).toMatchObject({
			allocated: 20_000,
		});
	});
});

describe("a forward that dies on its own", () => {
	it("is forgotten, so its port is handed out again", () => {
		// The container went away, or the network did. A registry holding a dead child would keep
		// offering a link to nothing and would never free what it allocated.
		startForward("w1", TARGET, 5173, "127.0.0.1");
		children[0]?.emit("exit", 255);

		expect(forwardsFor("w1")).toEqual([]);
		expect(startForward("w1", TARGET, 9999, "127.0.0.1")).toMatchObject({
			allocated: 20_000,
		});
	});

	it("is forgotten when ssh could not be run at all", () => {
		startForward("w1", TARGET, 5173, "127.0.0.1");
		children[0]?.emit("error", new Error("spawn ENOENT"));

		expect(forwardsFor("w1")).toEqual([]);
	});
});

describe("forwardsFor", () => {
	it("reports only the asked-for workspace", () => {
		startForward("w1", TARGET, 5173, "127.0.0.1");
		startForward("w2", TARGET, 3000, "127.0.0.1");

		expect(forwardsFor("w1")).toEqual([
			{ allocated: 20_000, port: 5173, workspaceId: "w1" },
		]);
	});

	it("says nothing for a workspace with none", () => {
		expect(forwardsFor("w1")).toEqual([]);
	});
});

describe("stopWorkspaceForwards", () => {
	it("takes down every forward for one workspace and leaves the others", () => {
		// Called when a workspace is destroyed. They would die on their own when the container
		// goes, but an ssh that hangs on a dead host holds its allocated port until it notices.
		startForward("w1", TARGET, 5173, "127.0.0.1");
		startForward("w1", TARGET, 3000, "127.0.0.1");
		startForward("w2", TARGET, 8080, "127.0.0.1");

		stopWorkspaceForwards("w1");

		expect(forwardsFor("w1")).toEqual([]);
		expect(forwardsFor("w2")).toHaveLength(1);
	});

	it("kills the process rather than only forgetting it", () => {
		// Dropping the entry without killing the child leaves an ssh holding a published port
		// that nothing in the application knows about any more.
		startForward("w1", TARGET, 5173, "127.0.0.1");

		stopWorkspaceForwards("w1");

		expect(children[0]?.killed).toBe(true);
	});
});
