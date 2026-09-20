import { lazy, type ReactNode, Suspense } from "react";

import { useMounted } from "../lib/use-mounted";
import { PanelNote, PanelSpinner } from "./panel-state";

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
			<PanelNote>
				A shell needs a running workspace. This one has none.
			</PanelNote>
		);
	}
	if (!mounted) {
		return <PanelSpinner label="Loading the terminal." />;
	}

	return (
		<Suspense fallback={<PanelSpinner label="Loading the terminal." />}>
			{/* Keyed, so switching workspaces builds a new terminal rather than re-running an
			    effect inside the old one.

			    The rail keeps an opened terminal mounted on purpose -- unmounting it closes the
			    socket and kills the shell -- and the selected tab survives a click to another
			    workspace. Between them, the same TerminalView instance would otherwise be handed a
			    new `workspaceId` and tear one shell down and open another in place. That is a
			    second shell in a div that belonged to the first; keying it removes the question. */}
			<TerminalView key={workspaceId} workspaceId={workspaceId} />
		</Suspense>
	);
}
