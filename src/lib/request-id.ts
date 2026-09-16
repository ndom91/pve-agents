// requestId returns an idempotency key for one form submission.
//
// Deliberately not crypto.randomUUID: that is restricted to secure contexts, and the controller
// is served over plain HTTP on the LAN, where it is undefined rather than merely weaker.
// getRandomValues carries no such restriction and is the same entropy source.
export function requestId(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);

	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
		"",
	);
}
