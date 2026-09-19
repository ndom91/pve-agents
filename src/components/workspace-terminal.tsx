import { lazy, type ReactNode, Suspense } from "react";

import { useMounted } from "../lib/use-mounted";

// Fetched when somebody opens the terminal tab, not when they open a workspace. xterm and its
// stylesheet are the largest thing on this page, and most visits are to read a screen rather than
// to type into one.
const TerminalView = lazy(() => import("./terminal-view"));

// WorkspaceTerminal is an interactive shell in the workspace, or the reason there is not one.
export function WorkspaceTerminal({
	ready,
	workspaceId,
}: {
	ready: boolean;
	workspaceId: string;
}): ReactNode {
	// xterm measures real glyphs to work out its grid, so there is nothing sensible for it to do on
	// the server. Same constraint as the tree and diff renderers, for a different reason.
	const mounted = useMounted();

	if (!ready) {
		// A workspace that is not ready has no address to reach, and one that is gone has no
		// container. Saying so beats a socket that fails with nothing to read.
		return (
			<p className="detail-note">
				A shell needs a running workspace. This one has none.
			</p>
		);
	}
	if (!mounted) {
		return <p className="detail-note">Loading the terminal.</p>;
	}

	return (
		<Suspense fallback={<p className="detail-note">Loading the terminal.</p>}>
			<TerminalView workspaceId={workspaceId} />
		</Suspense>
	);
}
