import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

// openDatabase opens a controller database and applies its idempotent schema migrations.
export function openDatabase(path: string): Database.Database {
	if (path !== ":memory:") {
		mkdirSync(dirname(path), { recursive: true });
	}

	const db = new Database(path);

	db.pragma("foreign_keys = ON");
	db.pragma("journal_mode = WAL");
	db.exec(`
		CREATE TABLE IF NOT EXISTS workspaces (
			id TEXT PRIMARY KEY,
			ownership_token TEXT NOT NULL,
			desired_state TEXT NOT NULL,
			status TEXT NOT NULL,
			activity TEXT NOT NULL,
			repository TEXT NOT NULL,
			ref TEXT NOT NULL,
			purpose TEXT,
			hostname TEXT NOT NULL,
			herdr_session TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			current_step TEXT NOT NULL,
			node TEXT,
			vmid INTEGER,
			ip TEXT,
			herdr_workspace_id TEXT,
			current_task_upid TEXT,
			error_code TEXT,
			error_message TEXT,
			error_retryable INTEGER,
			error_occurred_at TEXT,
			ready_at TEXT,
			last_activity_at TEXT,
			destroyed_at TEXT
		);

		CREATE TABLE IF NOT EXISTS idempotency_keys (
			key TEXT PRIMARY KEY,
			request_hash TEXT NOT NULL,
			workspace_id TEXT NOT NULL REFERENCES workspaces(id)
		);

		CREATE TABLE IF NOT EXISTS workspace_events (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			workspace_id TEXT NOT NULL REFERENCES workspaces(id),
			event_type TEXT NOT NULL,
			message TEXT NOT NULL,
			created_at TEXT NOT NULL
		);

		CREATE INDEX IF NOT EXISTS workspace_events_workspace_id
		ON workspace_events(workspace_id, id);
	`);

	return db;
}
