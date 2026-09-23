// What an opencode credential looks like on its way from the settings form into a workspace.
//
// opencode has no API that accepts a credential: `PATCH /api/credential/{id}` sets a label,
// `connect/key` takes an API key, and the OAuth routes need a person with a browser. What it does
// have is a `credential` table in ~/.local/share/opencode/opencode.db, and a row inserted there is
// read on the next start. So the runner writes the row, and this is the shape it is given.

// OpencodeCredential is the envelope an operator pastes into the Agents tab.
//
// An envelope rather than the bare value because the value does not say which integration it
// belongs to, and `integration_id` is a separate column. Harvesting produces both, so asking for
// both is asking for what is already in hand.
export type OpencodeCredential = {
	integration: string;
	value: string;
};

// readOpencodeCredential turns the stored string into something the runner can write.
//
// Refuses rather than repairs. A credential this cannot parse is one the workspace would come up
// unauthenticated with, and the operator needs to know that when they press save -- not when a
// workspace provisions an hour later and its agent says nothing useful about why it cannot start.
export function readOpencodeCredential(
	stored: string,
):
	| { credential: OpencodeCredential; kind: "read" }
	| { kind: "invalid"; message: string } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stored);
	} catch {
		return {
			kind: "invalid",
			message:
				'an opencode credential is JSON, like {"integration":"openai","value":{…}}',
		};
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return {
			kind: "invalid",
			message: "an opencode credential is a JSON object",
		};
	}

	const envelope = parsed as { integration?: unknown; value?: unknown };
	if (
		typeof envelope.integration !== "string" ||
		envelope.integration.trim() === ""
	) {
		return {
			kind: "invalid",
			message:
				'an opencode credential needs an "integration", such as "openai"',
		};
	}
	if (envelope.value === undefined || envelope.value === null) {
		return {
			kind: "invalid",
			message:
				'an opencode credential needs a "value", the blob from its credential row',
		};
	}

	return {
		credential: {
			integration: envelope.integration.trim(),
			// Stored as text in opencode's own column, so an object is re-serialised and a string is
			// passed through. Both arrive from a harvest depending on how it was pasted, and
			// rejecting one of them would be a rule about JSON rather than about credentials.
			value:
				typeof envelope.value === "string"
					? envelope.value
					: JSON.stringify(envelope.value),
		},
		kind: "read",
	};
}
