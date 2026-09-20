import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

const migrations = [
	{
		version: 1,
		sql: `
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

			CREATE INDEX IF NOT EXISTS workspaces_created_at
			ON workspaces(created_at DESC);
		`,
	},
	{
		version: 2,
		sql: `
			CREATE TABLE workspace_operations (
				id TEXT PRIMARY KEY,
				workspace_id TEXT NOT NULL REFERENCES workspaces(id),
				kind TEXT NOT NULL,
				status TEXT NOT NULL,
				created_at TEXT NOT NULL
			);

			CREATE INDEX workspace_operations_workspace_id
			ON workspace_operations(workspace_id, created_at DESC);
		`,
	},
	{
		version: 3,
		sql: `
			ALTER TABLE workspace_operations ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;
			ALTER TABLE workspace_operations ADD COLUMN claimed_at TEXT;
			ALTER TABLE workspace_operations ADD COLUMN lease_expires_at TEXT;
			ALTER TABLE workspace_operations ADD COLUMN completed_at TEXT;
			ALTER TABLE workspace_operations ADD COLUMN error_message TEXT;

			CREATE INDEX workspace_operations_claim
			ON workspace_operations(status, lease_expires_at, created_at);
		`,
	},
	{
		version: 4,
		sql: `
			ALTER TABLE workspaces ADD COLUMN current_task_expires_at TEXT;
			ALTER TABLE workspace_operations ADD COLUMN next_run_at TEXT;

			DROP INDEX IF EXISTS workspace_operations_claim;

			CREATE INDEX workspace_operations_claim
			ON workspace_operations(status, next_run_at, lease_expires_at, created_at);
		`,
	},
	{
		version: 5,
		sql: `
			ALTER TABLE workspace_operations ADD COLUMN lease_token TEXT;
		`,
	},
	{
		version: 6,
		sql: `
			ALTER TABLE workspaces ADD COLUMN destroy_phase TEXT;
		`,
	},
	{
		version: 7,
		sql: `
			ALTER TABLE workspaces ADD COLUMN provision_phase TEXT;
		`,
	},
	{
		version: 8,
		sql: `
			ALTER TABLE workspaces ADD COLUMN herdr_pane_id TEXT;
		`,
	},
	{
		version: 9,
		sql: `
			ALTER TABLE workspaces ADD COLUMN activity_observed_at TEXT;
		`,
	},
	{
		version: 10,
		sql: `
			ALTER TABLE workspaces ADD COLUMN git_credential_at TEXT;
		`,
	},
	{
		version: 11,
		sql: `
			CREATE TABLE controller_settings (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
		`,
	},
	{
		version: 12,
		sql: `
			ALTER TABLE workspaces ADD COLUMN unsaved_work INTEGER;
		`,
	},
	{
		// Herdr is gone, and these three columns were the whole of what it left in the schema: the
		// session its server ran under, and the workspace and pane ids of the terminal the agent
		// was a TUI in. Nothing reads them now, and a column nothing reads is a question the next
		// person has to answer before they can be sure.
		//
		// Dropped rather than left null. What is lost is the pane a destroyed container's agent
		// used to live in, which cannot be reached, restarted, or reasoned about now that the
		// software that owned it is not installed.
		version: 13,
		sql: `
			ALTER TABLE workspaces DROP COLUMN herdr_pane_id;
			ALTER TABLE workspaces DROP COLUMN herdr_workspace_id;
			ALTER TABLE workspaces DROP COLUMN herdr_session;
		`,
	},
	{
		// Files an operator uploads once and every new workspace is seeded with.
		//
		// Their own table rather than rows in controller_settings, which is key/value text behind a
		// fixed schema: a file has a destination, a size and a body, and none of those survive being
		// flattened into one string.
		//
		// The unique index is the load-bearing part. Two rows claiming the same destination is a
		// silent last-writer-wins during provisioning, and the operator would have no way to see
		// which of the two actually landed.
		version: 14,
		sql: `
			CREATE TABLE workspace_seed_files (
				id TEXT PRIMARY KEY,
				root TEXT NOT NULL,
				path TEXT NOT NULL,
				content TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
			CREATE UNIQUE INDEX workspace_seed_files_place
				ON workspace_seed_files (root, path);
		`,
	},
] as const;

// openDatabase opens a controller database and applies its idempotent schema migrations.
export function openDatabase(path: string): Database.Database {
	if (path !== ":memory:") {
		mkdirSync(dirname(path), { recursive: true });
	}

	const db = new Database(path);

	db.pragma("foreign_keys = ON");
	db.pragma("journal_mode = WAL");
	// better-sqlite3 throws SQLITE_BUSY immediately without this. The controller server and the
	// scheduler hold separate connections to the same file, and both take immediate write
	// transactions, so a lock collision is routine rather than exceptional.
	db.pragma("busy_timeout = 5000");
	db.exec(`
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version INTEGER PRIMARY KEY,
			applied_at TEXT NOT NULL
		);
	`);

	for (const migration of migrations) {
		const applied = db
			.prepare("SELECT version FROM schema_migrations WHERE version = ?")
			.get(migration.version) as { version: number } | undefined;
		if (applied !== undefined) {
			continue;
		}

		const apply = db.transaction(() => {
			db.exec(migration.sql);
			db.prepare(
				"INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
			).run(migration.version, new Date().toISOString());
		});

		apply();
	}

	return db;
}
