// MAX_TITLE is how long a workspace's name may be.
//
// The sidebar is about two hundred pixels wide and a title is the thing you scan it for. A model
// asked for six words sometimes answers with a sentence, and a person pasting into the field can
// paste anything at all, so this is enforced rather than requested.
export const MAX_TITLE = 60;

// readTitle turns whatever arrived into a name, or nothing.
//
// One guard for both sources. The runner's title comes from a model that was asked nicely; the
// operator's comes from a text field. Neither is trusted and both go through here.
//
// Returns undefined rather than an empty string for anything unusable, because absent is a state
// the rest of the system already has an answer for: the heading and the sidebar fall back to the
// hostname.
export function readTitle(value?: string): string | undefined {
	if (value === undefined) {
		return undefined;
	}

	const collapsed = value
		// Newlines included: a model that returns a title on its own line, or a heading and then a
		// sentence, should not become a two-line heading.
		.replace(/\s+/gu, " ")
		.trim();

	// Matched quotes only, and only one layer. A title that genuinely contains a quoted phrase in
	// the middle keeps it; the one this strips is the model wrapping its whole answer.
	const unquoted = /^(["'`])(.*)\1$/u.exec(collapsed)?.[2]?.trim() ?? collapsed;

	// A trailing full stop, which a model adds out of habit. Not "?" or "!", which a title can
	// legitimately end with, and not "..." which is doing work.
	const trimmed = unquoted.replace(/(?<![.])\.$/u, "").trim();
	if (trimmed === "") {
		return undefined;
	}

	return trimmed.length > MAX_TITLE
		? `${trimmed.slice(0, MAX_TITLE - 1).trimEnd()}…`
		: trimmed;
}
