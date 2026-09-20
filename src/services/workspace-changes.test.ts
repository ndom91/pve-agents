import { describe, expect, it } from "vitest";

import type { SshResult, SshRunner } from "./ssh";
import {
	changedFiles,
	commitAndPush,
	discardChanges,
	fileSides,
	workspaceBranch,
} from "./workspace-changes";

const TARGET = { address: "10.0.3.100", keyPath: "/keys/id", user: "agent" };
const CWD = "/workspace/repo";

// runs replies to every command with one result, recording what was asked.
function runs(result: Partial<SshResult> & { code?: number } = {}): {
	commands: string[][];
	ssh: SshRunner;
} {
	const commands: string[][] = [];

	return {
		commands,
		ssh: async (_target, command): Promise<SshResult> => {
			commands.push(command);

			return {
				code: 0,
				kind: "ran",
				stderr: "",
				stdout: "",
				...result,
			} as SshResult;
		},
	};
}

describe("changedFiles", () => {
	it("reads every porcelain code as the right kind of change", async () => {
		// The untracked case is the one that matters most. An agent creating a new file is the
		// commonest change and the one that most often holds a workspace back from being reaped,
		// and it is exactly what a patch-based approach would have shown as nothing at all.
		const listed = await changedFiles(
			TARGET,
			CWD,
			status([
				"?? NOTES.md",
				" M src/index.ts",
				"A  src/added.ts",
				" D src/gone.ts",
				"MM src/both.ts",
			]),
		);

		expect(listed).toEqual({
			files: [
				{ path: "NOTES.md", status: "untracked" },
				{ path: "src/index.ts", status: "modified" },
				{ path: "src/added.ts", status: "added" },
				{ path: "src/gone.ts", status: "deleted" },
				{ path: "src/both.ts", status: "modified" },
			],
			kind: "changes",
			unpushed: 0,
		});
	});

	it("calls a file added and then deleted deleted", async () => {
		// Calling it added would offer a diff of something that is no longer there.
		const listed = await changedFiles(TARGET, CWD, status(["AD src/gone.ts"]));

		expect(listed).toEqual({
			files: [{ path: "src/gone.ts", status: "deleted" }],
			kind: "changes",
			unpushed: 0,
		});
	});

	it("lists a rename once, at the name it has now", async () => {
		// Porcelain follows a rename with its original path as a second record. Showing both would
		// list one change as two files, one of which does not exist.
		const listed = await changedFiles(
			TARGET,
			CWD,
			status(["R  src/new.ts", "src/old.ts"]),
		);

		expect(listed).toEqual({
			files: [{ path: "src/new.ts", status: "renamed" }],
			kind: "changes",
			unpushed: 0,
		});
	});

	it("keeps a path containing a space intact", async () => {
		// The reason the status script asks for -z. Without it git quotes such paths, and the quotes
		// would become part of the name the diff is later requested for.
		const listed = await changedFiles(
			TARGET,
			CWD,
			status(["?? docs/release notes.md"]),
		);

		expect(listed).toEqual({
			files: [{ path: "docs/release notes.md", status: "untracked" }],
			kind: "changes",
			unpushed: 0,
		});
	});

	it("names HEAD when counting unpushed commits", async () => {
		// `--not --remotes` without a positive ref has nothing to walk and counts zero however much
		// is unpushed. It did, against a real workspace holding a commit, and the page then said
		// the agent had changed nothing.
		const { commands, ssh } = runs();
		await changedFiles(TARGET, CWD, ssh);

		expect(commands[0]?.join("\n")).toContain(
			"git rev-list --count HEAD --not --remotes",
		);
	});

	it("counts work that is committed and pushed nowhere", async () => {
		// A clean tree is not the same as no work. Reporting only the tree said "nothing changed"
		// about a workspace holding a commit that existed on one disk, and hid the control for
		// doing anything about it.
		const listed = await changedFiles(TARGET, CWD, status([], 2));

		expect(listed).toEqual({ files: [], kind: "changes", unpushed: 2 });
	});

	it("reads the count and the files from the same reply", async () => {
		const listed = await changedFiles(TARGET, CWD, status(["?? NOTES.md"], 3));

		expect(listed).toEqual({
			files: [{ path: "NOTES.md", status: "untracked" }],
			kind: "changes",
			unpushed: 3,
		});
	});

	it("reports a broken checkout rather than an empty list", async () => {
		// An empty list reads as "the agent changed nothing", which would be a lie about a
		// workspace whose clone failed.
		const listed = await changedFiles(TARGET, CWD, runs({ code: 4 }).ssh);

		expect(listed.kind).toBe("failed");
	});

	it("reports an unreachable workspace rather than throwing", async () => {
		const listed = await changedFiles(TARGET, CWD, async () => ({
			kind: "refused",
		}));

		expect(listed.kind).toBe("failed");
	});
});

describe("fileSides", () => {
	it("refuses a path reaching outside the checkout", async () => {
		// The path arrives from the browser. Nothing about the request guarantees it came from the
		// tree, and the read scripts would happily follow a traversal wherever it pointed.
		for (const path of ["../../etc/passwd", "/etc/passwd", "a/../../b"]) {
			const read = await fileSides(TARGET, CWD, path, async () => {
				throw new Error("a traversal must never reach the workspace");
			});

			expect(read.kind).toBe("failed");
		}
	});

	it("reads a file that exists on both sides", async () => {
		const read = await fileSides(TARGET, CWD, "src/index.ts", async () => ({
			code: 0,
			kind: "ran",
			stderr: "",
			stdout: "contents",
		}));

		expect(read).toEqual({
			after: "contents",
			before: "contents",
			kind: "contents",
		});
	});

	it("leaves the old side absent for a file the agent created", async () => {
		// Exit 9 is the scripts saying the side does not exist, as distinct from failing to read it.
		const read = await fileSides(
			TARGET,
			CWD,
			"NOTES.md",
			async (_target, command) =>
				command.join(" ").includes("cat-file")
					? { code: 9, kind: "ran", stderr: "", stdout: "" }
					: { code: 0, kind: "ran", stderr: "", stdout: "new file" },
		);

		expect(read).toEqual({
			after: "new file",
			before: undefined,
			kind: "contents",
		});
	});

	it("declines a file too large to be read as a diff", async () => {
		const read = await fileSides(TARGET, CWD, "dump.json", async () => ({
			code: 11,
			kind: "ran",
			stderr: "",
			stdout: "",
		}));

		expect(read.kind).toBe("too-large");
	});

	it("declines a binary rather than rendering it as source", async () => {
		const read = await fileSides(TARGET, CWD, "logo.png", async () => ({
			code: 0,
			kind: "ran",
			stderr: "",
			stdout: "PNG\0\0binary",
		}));

		expect(read.kind).toBe("binary");
	});
});

describe("commitAndPush", () => {
	it("pushes the workspace branch and never the checked-out ref", async () => {
		// The property the whole design turns on. Unreviewed agent output landing on main because
		// somebody clicked a button quickly is the outcome this exists to prevent.
		const { commands, ssh } = runs();
		await commitAndPush(
			TARGET,
			{ branch: "pve-agents/agent-bd48", cwd: CWD, message: "Agent work" },
			ssh,
		);

		const script = commands[0]?.join("\n") ?? "";
		expect(script).toContain('git push -u origin "$2"');
		expect(script).toContain('git switch -C "$2"');
		// The only branch named anywhere is the one passed in.
		expect(commands[0]).toContain("pve-agents/agent-bd48");
		expect(script).not.toContain("main");
	});

	it("hands the commit message over as an argument, not as script", async () => {
		// A message is free text from a person. Interpolated into the script it would be executed
		// by the remote shell.
		const { commands, ssh } = runs();
		await commitAndPush(
			TARGET,
			{ branch: "pve-agents/agent-bd48", cwd: CWD, message: '"; rm -rf / #' },
			ssh,
		);

		expect(commands[0]).toContain('"; rm -rf / #');
		expect(commands[0]?.join("\n")).toContain('git commit -m "$3"');
	});

	it("reports having nothing to push instead of making an empty commit", async () => {
		const pushed = await commitAndPush(
			TARGET,
			{ branch: "pve-agents/agent-bd48", cwd: CWD, message: "Agent work" },
			runs({ code: 8 }).ssh,
		);

		expect(pushed).toEqual({ kind: "nothing" });
	});

	it("reports a failing push rather than throwing", async () => {
		const pushed = await commitAndPush(
			TARGET,
			{ branch: "pve-agents/agent-bd48", cwd: CWD, message: "Agent work" },
			runs({ code: 1, stderr: "permission denied" }).ssh,
		);

		expect(pushed).toEqual({ kind: "failed", message: "permission denied" });
	});
});

describe("discardChanges", () => {
	it("throws the working tree away and leaves the commits alone", async () => {
		// The narrow version deliberately. Work that was committed but never pushed survives this
		// and still holds the workspace back from reaping, because destroying commits is not
		// something a button should do.
		const { commands, ssh } = runs();
		await discardChanges(TARGET, CWD, ssh);

		const script = commands[0]?.join("\n") ?? "";
		expect(script).toContain("git reset --hard HEAD");
		expect(script).toContain("git clean -fd");
		// -x would take ignored files with it, so a discard would also delete node_modules.
		expect(script).not.toContain("clean -fdx");
		expect(script).not.toContain("reset --hard HEAD~");
	});

	it("reports a failure rather than claiming the tree is clean", async () => {
		const discarded = await discardChanges(
			TARGET,
			CWD,
			runs({ code: 1, stderr: "index.lock exists" }).ssh,
		);

		expect(discarded).toEqual({
			kind: "failed",
			message: "index.lock exists",
		});
	});
});

describe("workspaceBranch", () => {
	it("gives one workspace one branch, however often it is pushed", async () => {
		expect(workspaceBranch("agent-bd48")).toBe("pve-agents/agent-bd48");
		expect(workspaceBranch("agent-bd48")).toBe(workspaceBranch("agent-bd48"));
	});
});

// status fakes porcelain -z output, whose records are NUL-separated rather than newline-separated.
function status(records: string[], unpushed = 0): SshRunner {
	return async (): Promise<SshResult> => ({
		code: 0,
		kind: "ran",
		stderr: "",
		// The count on its own line first, then the NUL-separated file list, which is the shape the
		// real script emits and the reason it is ordered that way: a path may contain a newline.
		stdout: `${unpushed}\n${records.join("\0")}\0`,
	});
}
