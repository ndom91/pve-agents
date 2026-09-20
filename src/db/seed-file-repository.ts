import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import {
	MAX_SEED_FILES,
	readSeedContent,
	readSeedPath,
	type SeedFile,
	type SeedFileInput,
	type SeedRoot,
} from "../domain/seed-file";

// SeedFileContent is one file as the provisioner needs it: where it goes and what is in it.
export type SeedFileContent = {
	content: string;
	path: string;
	root: SeedRoot;
};

// SaveSeedFileResult separates a saved file from one that was refused.
export type SaveSeedFileResult =
	| { file: SeedFile; kind: "saved" }
	| { kind: "invalid"; message: string };

type SeedFileRow = {
	bytes: number;
	id: string;
	path: string;
	root: string;
	updated_at: string;
};

// seedFiles lists what is configured, without the bodies.
//
// The settings page shows a destination and a size and never the content, so reading the bodies
// to render that list would ship every seeded file to the browser to display a number.
export function seedFiles(db: Database.Database): SeedFile[] {
	const rows = db
		.prepare(
			`SELECT id, root, path, LENGTH(content) AS bytes, updated_at
			 FROM workspace_seed_files ORDER BY root, path`,
		)
		.all() as SeedFileRow[];

	return rows.map((row) => ({
		bytes: row.bytes,
		id: row.id,
		path: row.path,
		root: row.root as SeedRoot,
		updatedAt: row.updated_at,
	}));
}

// seedFileContents reads every file with its body, for seeding a workspace.
//
// Separate from `seedFiles` rather than a flag on it, so the expensive read is the one a caller
// has to ask for by name.
export function seedFileContents(db: Database.Database): SeedFileContent[] {
	const rows = db
		.prepare(
			"SELECT root, path, content FROM workspace_seed_files ORDER BY root, path",
		)
		.all() as { content: string; path: string; root: string }[];

	return rows.map((row) => ({
		content: row.content,
		path: row.path,
		root: row.root as SeedRoot,
	}));
}

// readSeedFileContent reads one file's body, for the editor that is about to show it.
//
// One at a time, because `seedFiles` deliberately does not carry bodies and a list that fetched
// them all to render sizes is the thing that decision exists to avoid.
export function readSeedFileContent(
	db: Database.Database,
	id: string,
): string | undefined {
	const row = db
		.prepare("SELECT content FROM workspace_seed_files WHERE id = ?")
		.get(id) as { content: string } | undefined;

	return row?.content;
}

// saveSeedFile adds a file, updates one by id, or replaces whatever claims a destination.
//
// The path is re-checked here and not only at the route, because this is the last point before a
// destination becomes something a provisioner will write to.
//
// Three cases, and the middle one is why this is not a single upsert. An `id` that names an
// existing row is an *edit*, and an edit may move the file: the previous version upserted on
// (root, path), so renaming looked like an insert, kept the caller's id, and collided with the row
// already holding it. `ON CONFLICT(root, path)` does not catch a primary-key conflict, so that
// threw. Nothing hit it because no caller sent an id until the editor did.
export function saveSeedFile(
	db: Database.Database,
	input: SeedFileInput,
	now: Date = new Date(),
): SaveSeedFileResult {
	const destination = readSeedPath(input.root, input.path);
	if (destination.kind === "invalid") {
		return { kind: "invalid", message: destination.message };
	}

	// Checked against the normalised destination rather than the typed one, so " .claude.json"
	// is held to the same rule as the path it will actually be written to.
	const body = readSeedContent(input.root, destination.path, input.content);
	if (body.kind === "invalid") {
		return { kind: "invalid", message: body.message };
	}

	const holder = db
		.prepare("SELECT id FROM workspace_seed_files WHERE root = ? AND path = ?")
		.get(input.root, destination.path) as { id: string } | undefined;
	const editing =
		input.id === undefined
			? undefined
			: (db
					.prepare("SELECT id FROM workspace_seed_files WHERE id = ?")
					.get(input.id) as { id: string } | undefined);

	// Moving onto a destination somebody else holds. Refused by name rather than by overwriting
	// the other file, which is the one outcome nobody could undo.
	if (
		editing !== undefined &&
		holder !== undefined &&
		holder.id !== editing.id
	) {
		return {
			kind: "invalid",
			message: `another file already writes to ${destination.path}`,
		};
	}

	// Counted only when this is genuinely a new file. Saving an existing one at the limit is not
	// what the limit is protecting against.
	if (
		editing === undefined &&
		holder === undefined &&
		count(db) >= MAX_SEED_FILES
	) {
		return {
			kind: "invalid",
			message: `a workspace can be seeded with at most ${MAX_SEED_FILES} files`,
		};
	}

	const id = editing?.id ?? holder?.id ?? randomUUID();
	const updatedAt = now.toISOString();
	db.prepare(
		`INSERT INTO workspace_seed_files (id, root, path, content, updated_at)
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET root = excluded.root, path = excluded.path,
			content = excluded.content, updated_at = excluded.updated_at`,
	).run(id, input.root, destination.path, input.content, updatedAt);

	return {
		file: {
			bytes: Buffer.byteLength(input.content),
			id,
			path: destination.path,
			root: input.root,
			updatedAt,
		},
		kind: "saved",
	};
}

// removeSeedFile drops one file. Absent is success: the caller wanted it gone.
export function removeSeedFile(db: Database.Database, id: string): void {
	db.prepare("DELETE FROM workspace_seed_files WHERE id = ?").run(id);
}

function count(db: Database.Database): number {
	const row = db
		.prepare("SELECT COUNT(*) AS total FROM workspace_seed_files")
		.get() as { total: number };

	return row.total;
}
