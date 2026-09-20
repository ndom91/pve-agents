import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import {
	MAX_SEED_FILES,
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

// saveSeedFile adds a file, or replaces whatever already claims its destination.
//
// The path is re-checked here and not only at the route, because this is the last point before a
// destination becomes something a provisioner will write to.
export function saveSeedFile(
	db: Database.Database,
	input: SeedFileInput,
	now: Date = new Date(),
): SaveSeedFileResult {
	const destination = readSeedPath(input.root, input.path);
	if (destination.kind === "invalid") {
		return { kind: "invalid", message: destination.message };
	}

	const existing = db
		.prepare("SELECT id FROM workspace_seed_files WHERE root = ? AND path = ?")
		.get(input.root, destination.path) as { id: string } | undefined;
	// Counted before inserting, and only when this is genuinely a new destination. Replacing a
	// file at the limit is not the thing the limit is protecting against.
	if (existing === undefined && count(db) >= MAX_SEED_FILES) {
		return {
			kind: "invalid",
			message: `a workspace can be seeded with at most ${MAX_SEED_FILES} files`,
		};
	}

	const id = existing?.id ?? input.id ?? randomUUID();
	const updatedAt = now.toISOString();
	db.prepare(
		`INSERT INTO workspace_seed_files (id, root, path, content, updated_at)
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(root, path) DO UPDATE SET content = excluded.content,
			updated_at = excluded.updated_at`,
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
