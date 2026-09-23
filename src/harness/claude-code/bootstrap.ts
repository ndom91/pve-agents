// claudeSeed builds the settings that skip every first-run gate for one working directory.
//
// Two separate gates, found the hard way, one at a time. hasCompletedOnboarding skips the theme
// picker. hasTrustDialogAccepted skips the "is this a folder you trust" prompt, which is recorded
// per directory.
//
// Kept after the TUI was retired, deliberately. Both gates belonged to the interactive client and
// the SDK very probably asks neither — but "very probably" is not a thing to find out by having
// every new workspace fail to start. It is one small file written once during bootstrap, and every
// workspace verified so far was verified with it in place. Removing it is a change to make on
// purpose, with a workspace provisioned without it to prove the point.
export function claudeSeed(cwd: string): string {
	return JSON.stringify({
		hasCompletedOnboarding: true,
		projects: { [cwd]: { hasTrustDialogAccepted: true } },
	});
}
