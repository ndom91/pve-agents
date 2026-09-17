import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { quoteRemote } from "./ssh";

const run = promisify(execFile);

describe("quoteRemote", () => {
	it("keeps an argument containing spaces as one argument", async () => {
		// ssh joins the command it is given and the remote shell splits it again, so an unquoted
		// argument with a space silently becomes two. Checked against a real shell rather than an
		// expected string, because the thing under test is how a shell reads this.
		const argv = await remoteArgv(["printf", "%s\\n", "two words"]);

		expect(argv).toEqual(["two words"]);
	});

	it("does not let an argument run a second command", async () => {
		// The failure that matters: a repository name, ref, or agent prompt reaching the remote
		// shell is remote code execution under the controller's own key.
		const argv = await remoteArgv(["printf", "%s\\n", "x; id"]);

		expect(argv).toEqual(["x; id"]);
	});

	it("survives an embedded single quote", async () => {
		const argv = await remoteArgv(["printf", "%s\\n", "it's"]);

		expect(argv).toEqual(["it's"]);
	});

	it("keeps a shell script and its arguments separate", async () => {
		// The form used to launch a detached Herdr server: a fixed script, with data supplied
		// positionally so it is never parsed as shell.
		const argv = await remoteArgv([
			"sh",
			"-c",
			'printf %s\\\\n "$1"',
			"sh",
			"a b; c",
		]);

		expect(argv).toEqual(["a b; c"]);
	});
});

// remoteArgv runs a quoted command through a real shell, the way the far side of ssh does.
async function remoteArgv(command: string[]): Promise<string[]> {
	const { stdout } = await run("sh", ["-c", quoteRemote(command)]);

	return stdout.split("\n").filter((line) => line !== "");
}
