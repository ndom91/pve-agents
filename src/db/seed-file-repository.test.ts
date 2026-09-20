import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "./database";
import {
	readSeedFileContent,
	removeSeedFile,
	saveSeedFile,
	seedFileContents,
	seedFiles,
} from "./seed-file-repository";

const databases: Database.Database[] = [];

afterEach(() => {
	for (const db of databases) {
		db.close();
	}

	databases.length = 0;
});

describe("saveSeedFile", () => {
	it("replaces whatever already claims a destination rather than adding a rival", () => {
		// Two rows for one destination is a silent last-writer-wins during provisioning, and
		// nothing in the UI would show which of the two actually landed.
		const db = database();
		saveSeedFile(db, { content: "first", path: "CLAUDE.md", root: "repo" });
		saveSeedFile(db, { content: "second", path: "CLAUDE.md", root: "repo" });

		expect(seedFiles(db)).toHaveLength(1);
		expect(seedFileContents(db)[0]?.content).toBe("second");
	});

	it("keeps the same file's id across a replacement", () => {
		// The list keys on it, and a new id on every save makes the row look like a different file.
		const db = database();
		const first = saveSeedFile(db, {
			content: "a",
			path: "CLAUDE.md",
			root: "repo",
		});
		const second = saveSeedFile(db, {
			content: "b",
			path: "CLAUDE.md",
			root: "repo",
		});

		expect(first.kind).toBe("saved");
		expect(second.kind === "saved" && first.kind === "saved").toBe(true);
		expect(second.kind === "saved" ? second.file.id : "").toBe(
			first.kind === "saved" ? first.file.id : "other",
		);
	});

	it("treats the same path under two roots as two files", () => {
		// $HOME/CLAUDE.md and the repo's own CLAUDE.md are different files with different effects.
		const db = database();
		saveSeedFile(db, { content: "a", path: "CLAUDE.md", root: "repo" });
		saveSeedFile(db, { content: "b", path: "CLAUDE.md", root: "home" });

		expect(seedFiles(db)).toHaveLength(2);
	});

	it("moves a file when its destination is edited, rather than cloning it", () => {
		// Renaming used to throw. The upsert keyed on (root, path), so a new destination looked
		// like an insert, kept the caller's id, and collided with the row already holding it --
		// which ON CONFLICT(root, path) does not catch.
		const db = database();
		const first = saveSeedFile(db, {
			content: "a",
			path: "CLADUE.md",
			root: "repo",
		});
		const id = first.kind === "saved" ? first.file.id : "";

		const moved = saveSeedFile(db, {
			content: "a",
			id,
			path: "CLAUDE.md",
			root: "repo",
		});

		expect(moved.kind).toBe("saved");
		expect(seedFiles(db)).toHaveLength(1);
		expect(seedFiles(db)[0]?.path).toBe("CLAUDE.md");
	});

	it("refuses to move a file onto a destination another file holds", () => {
		// Overwriting the other file is the one outcome nobody could undo, so it is named instead.
		const db = database();
		const first = saveSeedFile(db, {
			content: "a",
			path: "one.md",
			root: "repo",
		});
		saveSeedFile(db, { content: "b", path: "two.md", root: "repo" });

		const clash = saveSeedFile(db, {
			content: "a",
			id: first.kind === "saved" ? first.file.id : "",
			path: "two.md",
			root: "repo",
		});

		expect(clash).toEqual({
			kind: "invalid",
			message: "another file already writes to two.md",
		});
		expect(
			seedFileContents(db)
				.map((f) => f.content)
				.sort(),
		).toEqual(["a", "b"]);
	});

	it("refuses a destination that steps outside its root", () => {
		// Re-checked here rather than trusted from the route, because this is the last point
		// before a destination becomes something a provisioner writes to.
		const db = database();

		expect(
			saveSeedFile(db, { content: "x", path: "../../etc/passwd", root: "home" })
				.kind,
		).toBe("invalid");
		expect(seedFiles(db)).toHaveLength(0);
	});
});

describe("seedFiles", () => {
	it("reports a size without reading the file", () => {
		const db = database();
		saveSeedFile(db, { content: "abcde", path: "CLAUDE.md", root: "repo" });

		expect(seedFiles(db)[0]?.bytes).toBe(5);
	});
});

describe("readSeedFileContent", () => {
	it("answers nothing for a file that is not there", () => {
		// A row removed in another tab while its editor was open. Throwing would take the page
		// down for a file the operator had already decided to be rid of.
		expect(readSeedFileContent(database(), "nothing")).toBeUndefined();
	});
});

describe("removeSeedFile", () => {
	it("treats an absent file as already gone", () => {
		// The caller wanted it removed and it is not there. Erroring would make a double-click a
		// failure.
		const db = database();

		expect(() => removeSeedFile(db, "nothing")).not.toThrow();
	});
});

function database(): Database.Database {
	const db = openDatabase(":memory:");
	databases.push(db);

	return db;
}
