import type { SshRunner, SshTarget } from "./ssh";

// FileStatus is what happened to one file, in the vocabulary the file tree already speaks.
//
// Deliberately git's own six minus "ignored", which git status does not report and nothing here
// would do with.
export type FileStatus =
	| "added"
	| "deleted"
	| "modified"
	| "renamed"
	| "untracked";

// ChangedFile is one entry in what the agent has done to the checkout.
export type ChangedFile = { path: string; status: FileStatus };

export type ChangedFiles =
	| { files: ChangedFile[]; kind: "changes" }
	| { kind: "failed"; message: string };

// FileSides is a file before and after, either side absent when it did not exist then.
//
// Contents rather than a patch because git produces no diff at all for an untracked file, and an
// agent creating a new file is both the commonest change and the one that most often holds a
// workspace back from being reaped. A patch-shaped answer would show that case as nothing.
export type FileSides =
	| { after?: string; before?: string; kind: "contents" }
	| { kind: "binary" }
	| { kind: "failed"; message: string }
	| { kind: "too-large" };

// ChangeAction is the outcome of doing something irreversible to the tree.
export type ChangeAction =
	| { branch?: string; kind: "done" }
	| { kind: "failed"; message: string }
	| { kind: "nothing" };

// Exit statuses the scripts use to say which thing went wrong, rather than printing it. Anything
// else non-zero is git failing on its own terms and its stderr is the better message.
const NO_DIR = 3;
const NOT_REPO = 4;
const NOTHING = 8;
const ABSENT = 9;
const TOO_LARGE = 11;

// MAX_FILE_BYTES caps what will be pulled across the link and into a browser tab.
//
// An agent can write a file of any size, and without a ceiling one `cat` would drag it through SSH,
// through the server, and into React. A megabyte is far past anything anyone reads as a diff.
const MAX_FILE_BYTES = 1_048_576;

// STATUS lists what changed, NUL-separated so no path needs quoting.
//
// The porcelain format quotes paths containing spaces or non-ASCII when it has to separate them by
// newline. -z removes the need, so every path arrives exactly as it is on disk.
const STATUS = [
	`cd "$1" || exit ${NO_DIR}`,
	`git rev-parse --git-dir >/dev/null 2>&1 || exit ${NOT_REPO}`,
	"git status --porcelain -z",
].join("\n");

// BEFORE reads a file as it was at the last commit.
const BEFORE = [
	`cd "$1" || exit ${NO_DIR}`,
	`git cat-file -e "HEAD:$2" 2>/dev/null || exit ${ABSENT}`,
	`[ "$(git cat-file -s "HEAD:$2")" -gt ${MAX_FILE_BYTES} ] && exit ${TOO_LARGE}`,
	'git show "HEAD:$2"',
].join("\n");

// AFTER reads a file as it is now.
const AFTER = [
	`cd "$1" || exit ${NO_DIR}`,
	`[ -f "$2" ] || exit ${ABSENT}`,
	`[ "$(wc -c < "$2")" -gt ${MAX_FILE_BYTES} ] && exit ${TOO_LARGE}`,
	'cat "$2"',
].join("\n");

// PUSH puts everything on a branch of its own and sends it.
//
// The branch is the point. Work an agent produced has not been reviewed by anyone, and a button
// that lands it on the checked-out ref turns one misjudged click into a commit on main. Pushing
// somewhere else instead is what makes this safe enough not to need a confirmation, and a
// confirmation people learn to dismiss protects nothing.
//
// `switch -C` resets the branch to HEAD rather than failing when it already exists, so pushing
// twice from the same workspace is the same operation done twice.
//
// Commit hooks are left to run. They can fail and block a rescue, which is annoying, but silently
// bypassing a repository's own checks to push code somewhere is the worse of the two.
const PUSH = [
	`cd "$1" || exit ${NO_DIR}`,
	`git rev-parse --git-dir >/dev/null 2>&1 || exit ${NOT_REPO}`,
	// Clean tree and HEAD already on a remote means there is nothing here to rescue.
	`if [ -z "$(git status --porcelain)" ] && [ -n "$(git branch -r --contains HEAD 2>/dev/null)" ]; then exit ${NOTHING}; fi`,
	"git add -A",
	'if ! git diff --cached --quiet; then git commit -m "$3" || exit 1; fi',
	'git switch -C "$2" || exit 1',
	'git push -u origin "$2" || exit 1',
].join("\n");

// DISCARD throws the working tree away and leaves the history alone.
//
// `reset --hard HEAD` rather than `checkout -- .` because the agent may have staged something, and
// checkout restores the tree from the index rather than from the commit, which would leave staged
// changes in place after a discard claimed to have removed them. HEAD does not move either way, so
// commits survive this and a workspace holding unpushed ones stays held afterwards. Destroying
// commits is not something a button should do.
//
// `clean -fd` without -x, so ignored files are left: a discard should not also delete node_modules.
const DISCARD = [
	`cd "$1" || exit ${NO_DIR}`,
	`git rev-parse --git-dir >/dev/null 2>&1 || exit ${NOT_REPO}`,
	"git reset --hard HEAD",
	"git clean -fd",
].join("\n");

// changedFiles lists what the agent has done to the checkout.
export async function changedFiles(
	target: SshTarget,
	cwd: string,
	ssh: SshRunner,
): Promise<ChangedFiles> {
	const result = await ssh(target, ["sh", "-c", STATUS, "sh", cwd]);
	if (result.kind !== "ran" || result.code !== 0) {
		return failure(result, cwd);
	}

	return { files: parseStatus(result.stdout), kind: "changes" };
}

// fileSides reads one file as it was and as it is.
export async function fileSides(
	target: SshTarget,
	cwd: string,
	path: string,
	ssh: SshRunner,
): Promise<FileSides> {
	// The path arrives from the browser. Everything the UI offers came out of git status and is
	// inside the checkout, but nothing about the request guarantees that, and both scripts would
	// happily read whatever a traversal pointed them at.
	if (!withinCheckout(path)) {
		return { kind: "failed", message: "path is outside the checkout" };
	}

	const [before, after] = await Promise.all([
		side(target, BEFORE, cwd, path, ssh),
		side(target, AFTER, cwd, path, ssh),
	]);

	for (const read of [before, after]) {
		if (read.kind === "failed" || read.kind === "too-large") {
			return read;
		}
	}
	if (before.kind === "binary" || after.kind === "binary") {
		return { kind: "binary" };
	}

	return {
		after: after.kind === "text" ? after.text : undefined,
		before: before.kind === "text" ? before.text : undefined,
		kind: "contents",
	};
}

// commitAndPush saves everything in the workspace onto a branch of its own.
export async function commitAndPush(
	target: SshTarget,
	input: { branch: string; cwd: string; message: string },
	ssh: SshRunner,
): Promise<ChangeAction> {
	const result = await ssh(target, [
		"sh",
		"-c",
		PUSH,
		"sh",
		input.cwd,
		input.branch,
		input.message,
	]);
	if (result.kind !== "ran" || result.code !== 0) {
		return result.kind === "ran" && result.code === NOTHING
			? { kind: "nothing" }
			: failure(result, input.cwd);
	}

	return { branch: input.branch, kind: "done" };
}

// discardChanges throws the working tree away.
export async function discardChanges(
	target: SshTarget,
	cwd: string,
	ssh: SshRunner,
): Promise<ChangeAction> {
	const result = await ssh(target, ["sh", "-c", DISCARD, "sh", cwd]);

	return result.kind !== "ran" || result.code !== 0
		? failure(result, cwd)
		: { kind: "done" };
}

// workspaceBranch is where a workspace's work goes, one branch per workspace.
//
// Derived from the hostname rather than chosen per push, so pushing twice updates one branch
// instead of littering the repository with a branch per click.
export function workspaceBranch(hostname: string): string {
	return `herdr/${hostname}`;
}

// SideRead is one half of a file, or the reason there is no usable half.
type SideRead =
	| { kind: "absent" }
	| { kind: "binary" }
	| { kind: "failed"; message: string }
	| { kind: "text"; text: string }
	| { kind: "too-large" };

async function side(
	target: SshTarget,
	script: string,
	cwd: string,
	path: string,
	ssh: SshRunner,
): Promise<SideRead> {
	const result = await ssh(target, ["sh", "-c", script, "sh", cwd, path]);
	if (result.kind === "refused") {
		return { kind: "failed", message: "workspace refused the connection" };
	}
	if (result.kind === "rejected") {
		return { kind: "failed", message: result.message };
	}
	if (result.code === ABSENT) {
		return { kind: "absent" };
	}
	if (result.code === TOO_LARGE) {
		return { kind: "too-large" };
	}
	if (result.code !== 0) {
		return {
			kind: "failed",
			message: result.stderr.trim() || `git exited ${result.code}`,
		};
	}

	// A NUL byte is the same test git itself uses. Rendering a binary as source would be noise at
	// best, and the diff library has no more idea what to do with it than a person would.
	return result.stdout.includes("\0")
		? { kind: "binary" }
		: { kind: "text", text: result.stdout };
}

// parseStatus turns porcelain output into the tree's vocabulary.
//
// Every record is a two-letter code, a space, then a path. A rename or a copy carries the original
// path as the next record, which is consumed and dropped: the tree shows where a file is now, and
// showing both would list a rename twice.
function parseStatus(stdout: string): ChangedFile[] {
	const fields = stdout.split("\0").filter((field) => field !== "");
	const files: ChangedFile[] = [];

	for (let index = 0; index < fields.length; index += 1) {
		const record = fields[index] ?? "";
		if (record.length < 4) {
			continue;
		}

		const code = record.slice(0, 2);
		if (code[0] === "R" || code[0] === "C") {
			index += 1;
		}

		files.push({ path: record.slice(3), status: statusOf(code) });
	}

	return files;
}

// statusOf picks the one word that best describes a two-letter code.
//
// Order is the whole content here. "AD" is a file added to the index and then deleted from the
// tree, and calling that added would offer a diff of something no longer there, so deletion is
// checked before addition.
function statusOf(code: string): FileStatus {
	if (code === "??") {
		return "untracked";
	}
	if (code.includes("D")) {
		return "deleted";
	}
	if (code[0] === "R" || code[0] === "C") {
		return "renamed";
	}
	if (code.includes("A")) {
		return "added";
	}

	return "modified";
}

// withinCheckout rejects a path that could reach outside the repository.
//
// Spaces and other awkward characters are allowed: the path reaches the workspace as a positional
// argument and is never parsed as shell, so only the traversal is worth refusing.
function withinCheckout(path: string): boolean {
	return (
		path !== "" &&
		!path.startsWith("/") &&
		!path.split("/").includes("..") &&
		!path.includes("\0")
	);
}

// failure turns a result that is not a success into the one message an operator will read.
function failure(
	result: Awaited<ReturnType<SshRunner>>,
	cwd: string,
): { kind: "failed"; message: string } {
	if (result.kind === "refused") {
		return { kind: "failed", message: "workspace refused the connection" };
	}
	if (result.kind === "rejected") {
		return { kind: "failed", message: result.message };
	}

	return {
		kind: "failed",
		message:
			result.code === NO_DIR || result.code === NOT_REPO
				? `${cwd} is not a readable git repository`
				: result.stderr.trim() || `git exited ${result.code}`,
	};
}
