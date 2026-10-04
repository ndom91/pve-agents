import type Database from "better-sqlite3";

// SavedTranscript is a workspace's conversation as it stood just before its container went.
export type SavedTranscript = {
	capturedAt: string;
	// Which agent produced the messages, so the page reads them with the right harness. From the
	// runner's own snapshot, for the same reason the live page takes it from there.
	harness: string;
	// The runner's messages as the JSON they were stored as, unparsed.
	//
	// A string because nobody on this side reads them: they go to the browser, which renders them
	// through the harness. Parsing here only to serialise again for the wire would be two passes
	// over megabytes for nothing, and `unknown[]` is not a type a server function may return.
	messagesJson: string;
	sessionId?: string;
};

// TranscriptCapture is what the destroy step hands over to be kept.
export type TranscriptCapture = {
	harness: string;
	messages: unknown[];
	sessionId?: string;
};

// TRANSCRIPT_UNSAVED is the timeline entry a failed capture writes.
//
// A constant because it is read back as well as written: the destroy executor counts these to
// decide when to stop trying, so the count and the note can never drift into two spellings.
export const TRANSCRIPT_UNSAVED = "workspace.transcript_unsaved";

type TranscriptRow = {
	captured_at: string;
	harness: string;
	messages: string;
	session_id: string | null;
};

// saveWorkspaceTranscript records a workspace's conversation, replacing any earlier copy.
//
// An upsert rather than a plain insert. The destroy step skips a workspace already kept, but a lease
// that expires mid-read lets a second worker reach here too, and a key conflict would fail a
// destroy over a conversation that was already safe.
export function saveWorkspaceTranscript(
	db: Database.Database,
	workspaceId: string,
	transcript: TranscriptCapture,
	now: Date,
): void {
	db.prepare(
		`INSERT INTO workspace_transcripts
			(workspace_id, harness, session_id, messages, message_count, captured_at)
		 VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT (workspace_id) DO UPDATE SET
			harness = excluded.harness,
			session_id = excluded.session_id,
			messages = excluded.messages,
			message_count = excluded.message_count,
			captured_at = excluded.captured_at`,
	).run(
		workspaceId,
		transcript.harness,
		transcript.sessionId ?? null,
		JSON.stringify(transcript.messages),
		transcript.messages.length,
		now.toISOString(),
	);
}

// workspaceTranscript reads a saved conversation back, or nothing if none was kept.
//
// Nothing is an ordinary answer: every workspace destroyed before this shipped has none, and so
// does one whose runner could not be read on the way out.
export function workspaceTranscript(
	db: Database.Database,
	workspaceId: string,
): SavedTranscript | undefined {
	const row = db
		.prepare(
			`SELECT harness, session_id, messages, captured_at
			 FROM workspace_transcripts WHERE workspace_id = ?`,
		)
		.get(workspaceId) as TranscriptRow | undefined;
	if (row === undefined) {
		return undefined;
	}

	return {
		capturedAt: row.captured_at,
		harness: row.harness,
		messagesJson: row.messages,
		sessionId: row.session_id ?? undefined,
	};
}

// hasWorkspaceTranscript says whether a conversation is already kept, without reading it.
export function hasWorkspaceTranscript(
	db: Database.Database,
	workspaceId: string,
): boolean {
	return (
		db
			.prepare("SELECT 1 FROM workspace_transcripts WHERE workspace_id = ?")
			.get(workspaceId) !== undefined
	);
}

// failedTranscriptCaptures counts how often reading the conversation on the way out has failed.
//
// Counted from the timeline rather than kept in a column of its own. The notes have to be written
// anyway, so the operator can see why a conversation is missing, and a separate counter would be a
// second record of the same fact that could disagree with the first.
export function failedTranscriptCaptures(
	db: Database.Database,
	workspaceId: string,
): number {
	return (
		db
			.prepare(
				"SELECT COUNT(*) AS count FROM workspace_events WHERE workspace_id = ? AND event_type = ?",
			)
			.get(workspaceId, TRANSCRIPT_UNSAVED) as { count: number }
	).count;
}
