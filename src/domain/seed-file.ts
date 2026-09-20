import { z } from "zod";

import { AGENT_CWD } from "./workspace-layout";

// MAX_SEED_BYTES caps one file.
//
// The content travels on an SSH stdin pipe and lives in a SQLite TEXT column, so this is a bound on
// both. Generous for a CLAUDE.md or a settings file, and far short of anything that would make a
// provision noticeably slower.
export const MAX_SEED_BYTES = 256 * 1024;

// MAX_SEED_FILES caps how many are applied to a workspace.
//
// Each one is its own SSH round trip during provisioning, so this is the ceiling on what seeding
// can cost a workspace that is otherwise ready.
export const MAX_SEED_FILES = 32;

// SeedRoot is what a destination path is relative to.
//
// "absolute" is not a hole in the validation below, and the distinction is the point of having
// roots at all. An operator can already open the Terminal tab and write anything as the agent user,
// so this is not a privilege boundary. What it prevents is a path that silently escapes the root it
// claims -- a "home" entry that is really writing to /etc. Choosing "absolute" says so out loud.
export const SEED_ROOTS = ["home", "repo", "absolute"] as const;
export type SeedRoot = (typeof SEED_ROOTS)[number];

// seedFileSchema is one file as it arrives from the browser.
export const seedFileSchema = z.object({
	content: z
		.string()
		.max(MAX_SEED_BYTES, `file is larger than ${MAX_SEED_BYTES} bytes`),
	// Present when replacing a file, absent when adding one.
	id: z.string().optional(),
	path: z.string().min(1).max(512),
	root: z.enum(SEED_ROOTS),
});

export type SeedFileInput = z.output<typeof seedFileSchema>;

// SeedFile is a stored file. `content` is deliberately absent: the settings page lists dozens of
// these and never shows their contents, and shipping them all to the browser to render a size is
// the kind of thing that is fine until somebody seeds a large one.
export type SeedFile = {
	bytes: number;
	id: string;
	path: string;
	root: SeedRoot;
	updatedAt: string;
};

// readSeedPath checks one destination and says why it is refused rather than just that it is.
//
// Pure, and the only place the rule lives. The container resolves the path for real -- $HOME is not
// knowable from here -- so this cannot be enforced at the point of writing, which is exactly why it
// has to be enforced at the point of saving.
export function readSeedPath(
	root: SeedRoot,
	path: string,
): { kind: "invalid"; message: string } | { kind: "valid"; path: string } {
	const trimmed = path.trim();
	if (trimmed === "") {
		return { kind: "invalid", message: "a destination is required" };
	}
	// A newline would end the line this path is written on, and a null byte truncates it on the
	// way through the shell. Neither can appear in a real destination.
	if (/[\0\n\r]/.test(trimmed)) {
		return {
			kind: "invalid",
			message: "a destination cannot contain newlines",
		};
	}

	const absolute = trimmed.startsWith("/");
	if (root === "absolute" && !absolute) {
		return {
			kind: "invalid",
			message: "an absolute destination must start with /",
		};
	}
	if (root !== "absolute" && absolute) {
		return {
			kind: "invalid",
			message: `a ${root} destination is relative, so it cannot start with /`,
		};
	}

	// Checked segment by segment rather than as a substring, so a file legitimately named
	// "..config" is allowed and only a real parent-directory step is refused.
	if (trimmed.split("/").includes("..")) {
		return {
			kind: "invalid",
			message: "a destination cannot step outside its root with ..",
		};
	}

	return { kind: "valid", path: trimmed };
}

// resolveSeedPath is where a file will land, for the operator to read before saving.
//
// $HOME is not known here, so the home case is shown symbolically. The container does the real
// resolution; this exists so nobody discovers the answer by provisioning a workspace.
export function resolveSeedPath(root: SeedRoot, path: string): string {
	if (root === "absolute") {
		return path;
	}

	return `${root === "home" ? "$HOME" : AGENT_CWD}/${path}`;
}
