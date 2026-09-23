import { z } from "zod";

// A harness an operator has configured, as opposed to a harness this build can drive.
//
// Deliberately separate from `./harness.ts`, which is the registry of code. That file answers "what
// can this build run"; this one answers "what has somebody set up". They meet at `kind`.

// MAX_CREDENTIAL_BYTES caps one credential.
//
// Generous on purpose. A Claude OAuth token is a few hundred bytes and opencode's is about two
// thousand, but a credential is somebody else's format and the next one is not this one. The cap is
// here to stop a paste accident becoming a database row, not to express a belief about tokens.
export const MAX_CREDENTIAL_BYTES = 16 * 1024;

// harnessConfigSchema is one harness as it arrives from the browser.
export const harnessConfigSchema = z.object({
	// Absent when the field was left blank on an edit, which means "keep the stored one". A
	// credential is the one field where blank cannot mean empty: an operator renaming a harness
	// would otherwise blank its token and find out at the next provision.
	credential: z
		.string()
		.max(
			MAX_CREDENTIAL_BYTES,
			`a credential cannot exceed ${MAX_CREDENTIAL_BYTES} bytes`,
		)
		.optional(),
	enabled: z.boolean().default(true),
	// Present when editing, absent when adding.
	id: z.string().optional(),
	// Validated against the registry by the caller rather than as an enum here, so adding a harness
	// stays a matter of adding a directory.
	kind: z.string().min(1).max(64),
	// Optional, and its absence means "whatever that agent thinks is current". claude-code's SDK
	// chooses for itself; opencode asks its own server for a default. A name pinned here is a name
	// that goes stale without anything noticing.
	model: z.string().trim().max(255).optional(),
	name: z.string().trim().min(1).max(64),
	permissionMode: z.string().trim().min(1).max(64).default("auto"),
});

export type HarnessConfigInput = z.output<typeof harnessConfigSchema>;

// HarnessConfig is a stored harness as the browser is allowed to see it.
//
// `credential` is deliberately absent, and its absence is the type doing real work: this shape is
// what the list endpoint returns, so a credential cannot reach the browser by someone forgetting to
// strip it. `hasCredential` is what the page actually needs -- whether it is set, not what it is.
export type HarnessConfig = {
	enabled: boolean;
	hasCredential: boolean;
	id: string;
	kind: string;
	model?: string;
	name: string;
	permissionMode: string;
	updatedAt: string;
};

// HarnessSecret is a stored harness including what it is for.
//
// Named so that reaching for it is a decision. Only provisioning needs this, and only on the server.
export type HarnessSecret = HarnessConfig & { credential: string };
