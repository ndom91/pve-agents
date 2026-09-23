import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import type {
	HarnessConfig,
	HarnessConfigInput,
	HarnessSecret,
} from "../domain/harness-config";

// SaveHarnessResult separates a saved harness from one that was refused.
export type SaveHarnessResult =
	| { harness: HarnessConfig; kind: "saved" }
	| { kind: "invalid"; message: string };

type HarnessRow = {
	credential: string;
	enabled: number;
	id: string;
	kind: string;
	model: string | null;
	name: string;
	updated_at: string;
};

// SELECT_PUBLIC is every column except the credential.
//
// Spelled out rather than `SELECT *` so that adding a secret column later cannot quietly widen what
// the list endpoint returns. The one place that wants the credential asks for it by name.
const SELECT_PUBLIC = `SELECT id, name, kind, model, enabled, updated_at
	 FROM harnesses`;

function readPublic(row: Omit<HarnessRow, "credential">): HarnessConfig {
	return {
		enabled: row.enabled === 1,
		id: row.id,
		kind: row.kind,
		model: row.model ?? undefined,
		name: row.name,
		updatedAt: row.updated_at,
	};
}

// harnesses lists what is configured, without the credentials.
//
// The type it returns has no credential field at all, so this cannot leak one by omission -- see
// HarnessConfig. That matters more here than for seed files, whose bodies the operator edits.
export function harnesses(db: Database.Database): HarnessConfig[] {
	const rows = db.prepare(`${SELECT_PUBLIC} ORDER BY name`).all() as Omit<
		HarnessRow,
		"credential"
	>[];

	return rows.map(readPublic);
}

// enabledHarnesses is what a workspace can be launched on.
//
// Separate from `harnesses` because the settings page shows the disabled ones -- that is how they
// get re-enabled -- and the launch form must not offer them.
export function enabledHarnesses(db: Database.Database): HarnessConfig[] {
	return harnesses(db).filter((harness) => harness.enabled);
}

// harnessSecret reads one harness including its credential, for provisioning a workspace.
//
// Named so that reaching for it is a decision rather than a default. Every other reader gets the
// shape without the credential in it.
export function harnessSecret(
	db: Database.Database,
	id: string,
): HarnessSecret | undefined {
	const row = db
		.prepare(
			`SELECT id, name, kind, model, enabled, updated_at, credential
			 FROM harnesses WHERE id = ?`,
		)
		.get(id) as HarnessRow | undefined;

	return row === undefined
		? undefined
		: { ...readPublic(row), credential: row.credential };
}

// harnessForWorkspace is the agent one workspace runs, with its credential.
//
// Undefined when the harness row has been deleted since the workspace was launched, which is a real
// state and not a bug: an operator can remove an agent while a workspace is still provisioning on
// it. Callers stop with a named reason rather than falling back to another agent, because running
// an agent nobody asked for is the worst answer available.
//
// A workspace with no harness recorded ran claude-code -- it predates harnesses being rows, and
// that is the only thing this controller could run then -- so it resolves to whichever claude-code
// row exists.
//
// One function for the provisioner and the probe CLI both. The probe had its own version that
// picked the first claude-code harness regardless of the workspace, which meant probing an opencode
// workspace installed Claude's runner over it.
export function harnessForWorkspace(
	db: Database.Database,
	workspaceId: string,
	legacyKind: string,
): HarnessSecret | undefined {
	const row = db
		.prepare("SELECT harness_id FROM workspaces WHERE id = ?")
		.get(workspaceId) as { harness_id: string | null } | undefined;
	if (row?.harness_id != null) {
		return harnessSecret(db, row.harness_id);
	}

	const legacy = harnesses(db).find((entry) => entry.kind === legacyKind);

	return legacy === undefined ? undefined : harnessSecret(db, legacy.id);
}

// saveHarness adds one, or updates one by id.
//
// A blank credential on an update keeps the stored one. That is the single most important rule in
// this file: the alternative is that renaming a harness blanks its token, and the operator finds out
// when the next workspace fails to provision rather than when they pressed save.
export function saveHarness(
	db: Database.Database,
	input: HarnessConfigInput,
	now: Date = new Date(),
): SaveHarnessResult {
	const credential = input.credential?.trim() ?? "";
	const existing =
		input.id === undefined ? undefined : harnessSecret(db, input.id);
	if (input.id !== undefined && existing === undefined) {
		return { kind: "invalid", message: "that harness no longer exists" };
	}
	if (existing === undefined && credential === "") {
		return {
			kind: "invalid",
			message: "a credential is required",
		};
	}

	const id = existing?.id ?? randomUUID();
	const nowText = now.toISOString();

	try {
		db.prepare(
			`INSERT INTO harnesses
				(id, name, kind, credential, model, enabled, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET
				name = excluded.name,
				kind = excluded.kind,
				credential = excluded.credential,
				model = excluded.model,
				enabled = excluded.enabled,
				updated_at = excluded.updated_at`,
		).run(
			id,
			input.name,
			input.kind,
			credential === "" ? (existing?.credential ?? "") : credential,
			input.model === undefined || input.model === "" ? null : input.model,
			input.enabled ? 1 : 0,
			nowText,
			nowText,
		);
	} catch (error) {
		// The unique index on name. Reported as the conflict it is, because "UNIQUE constraint
		// failed: harnesses.name" is not a sentence for an operator.
		if (String(error).includes("UNIQUE")) {
			return {
				kind: "invalid",
				message: `another harness is already called "${input.name}"`,
			};
		}

		throw error;
	}

	const saved = harnessSecret(db, id);
	if (saved === undefined) {
		return { kind: "invalid", message: "the harness could not be saved" };
	}

	// Destructured rather than deleted, so the credential is dropped by the shape of the code and
	// not by a line someone can move.
	const { credential: _secret, ...harness } = saved;

	return { harness, kind: "saved" };
}

// deleteHarness removes one.
//
// Workspaces already provisioned on it are untouched and keep running: their runner is installed and
// their credential was written into their container at provision time, so nothing about them reads
// this row again.
export function deleteHarness(db: Database.Database, id: string): void {
	db.prepare("DELETE FROM harnesses WHERE id = ?").run(id);
}
