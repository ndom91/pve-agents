import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ArrowDown, ArrowUp } from "lucide-react";
import { useState } from "react";
import { AgentScreen } from "../components/agent-screen";
import { Button } from "../components/button";
import { ChangesActions } from "../components/changes-actions";
import { ChangesPanel } from "../components/changes-panel";
import { IconButton } from "../components/icon-button";
import { WorkspaceBadges } from "../components/workspace-badges";
import type { RailTab } from "../components/workspace-rail";
import { WorkspaceRail } from "../components/workspace-rail";
import { WorkspaceTerminal } from "../components/workspace-terminal";
import { WorkspaceTimeline } from "../components/workspace-timeline";
import type { WorkspaceOutcome } from "../domain/workspace-outcome";
import { workspaceOutcome } from "../domain/workspace-outcome";
import {
	changesQuery,
	paneQuery,
	workspaceKeys,
	workspaceQuery,
} from "../lib/queries";
import { useOptimisticWorkspace } from "../lib/use-optimistic-workspace";
import { useWorkspaceStream } from "../lib/use-workspace-stream";
import {
	discardWorkspaceChanges,
	promptWorkspaceAgent,
	pushWorkspaceChanges,
	sendWorkspaceKeys,
} from "../server/agent.functions";
import {
	destroyWorkspaceRequest,
	retryWorkspaceRequest,
} from "../server/workspace.functions";

export const Route = createFileRoute("/_dashboard/workspaces/$workspaceId")({
	component: WorkspaceDetail,
	loader: ({ context, params }) =>
		context.queryClient.ensureQueryData(workspaceQuery(params.workspaceId)),
});

// ANSWER_KEYS are the presses offered when an agent is waiting at a dialog. The adapter holds the
// real allow-list; these are the ones worth a button.
const ANSWER_KEYS = ["1", "2", "3", "up", "down", "enter", "esc"] as const;

// ARROWS get an icon instead of a word, because a direction is what they mean.
const ARROWS: Record<string, typeof ArrowUp> = { down: ArrowDown, up: ArrowUp };

// RESOLVES are the presses that actually end a dialog.
//
// Navigation does not: up and down move the selection and the agent is still waiting afterwards.
// Predicting that it had gone back to work made the controls vanish from under the cursor and
// reappear a moment later, which is the worst possible moment for the page to move.
const RESOLVES = new Set(["1", "2", "3", "enter", "esc"]);

function WorkspaceDetail() {
	const { workspaceId } = Route.useParams();
	const queryClient = useQueryClient();
	const { data: workspace } = useQuery(workspaceQuery(workspaceId));
	const [prompt, setPrompt] = useState("");
	const [note, setNote] = useState("");
	const [tab, setTab] = useState<RailTab>({ kind: "details" });
	// Bumped when work is discarded, and used as the change list's key so it remounts collapsed.
	// A row left unfolded over a file that has just been thrown away is showing a diff of nothing.
	const [discarded, setDiscarded] = useState(0);

	const ready = workspace?.status === "ready";
	// Nothing can be done to it any more: no terminal, no prompt, no diff to push or discard.
	const finished =
		workspace?.status === "destroyed" || workspace?.status === "failed";
	const blocked = workspace?.activity === "blocked";
	const { data: pane } = useQuery(paneQuery(workspaceId, ready));

	// Gated on the tab, not merely on the workspace: each fetch is an SSH connection, and polling
	// one for a panel nobody has opened would cost a connection every fifteen seconds for nothing.
	//
	// Any tab but Details counts. The actions sit under the diff, and the terminal and timeline are
	// both places somebody goes to decide whether there is anything worth keeping.
	const { data: changes } = useQuery(
		changesQuery(workspaceId, ready && tab.kind !== "details"),
	);

	// Pushes the screen and the observed activity straight into the cache while the page is open.
	useWorkspaceStream(workspaceId, ready);

	const predict = useOptimisticWorkspace(workspaceId);

	// Every operator action refreshes the same two keys, so the timeline shows what was just done
	// without waiting for the next poll.
	const refresh = async () => {
		await Promise.all([
			queryClient.invalidateQueries({
				queryKey: workspaceKeys.detail(workspaceId),
			}),
			queryClient.invalidateQueries({ queryKey: workspaceKeys.list() }),
		]);
	};

	const send = useMutation({
		mutationFn: (text: string) =>
			promptWorkspaceAgent({ data: { id: workspaceId, text } }),
		// Never predicts away "blocked". Showing a blocked agent as working hides the one state
		// that needs a person, which is worse than a badge that lags.
		onMutate: () => (blocked ? undefined : predict({ activity: "active" })),
		onError: async (_error, _text, rollback) => {
			rollback?.();
			setNote("could not reach the agent");
		},
		onSuccess: async (result, _text, rollback) => {
			// Accepted-but-refused still has to put the prediction back: the agent is not working,
			// it is waiting.
			if (result.kind !== "sent") {
				rollback?.();
				setNote(
					result.kind === "blocked"
						? "The agent is waiting for input. Answer it first."
						: result.reason,
				);

				return;
			}

			setPrompt("");
			setNote("");
			await refresh();
		},
	});

	const answer = useMutation({
		mutationFn: (key: string) =>
			sendWorkspaceKeys({ data: { id: workspaceId, key } }),
		// Only for a press that ends the dialog. A prediction here is a claim that the agent has
		// gone back to work, which is not true of moving a selection.
		onMutate: (key) =>
			RESOLVES.has(key) ? predict({ activity: "active" }) : undefined,
		onError: async (_error, _key, rollback) => {
			rollback?.();
			setNote("could not reach the agent");
		},
		onSuccess: async (result, _key, rollback) => {
			if (result.kind !== "sent") {
				rollback?.();
			}
			setNote(result.kind === "unavailable" ? result.reason : "");
			await refresh();
		},
	});

	// Refreshing the change list after either action is what closes the loop: the tree, the
	// unsaved-work badge and the timeline all describe the same tree, and leaving any of them
	// showing the state from before would make a workspace look held after its work was saved.
	const settle = async () => {
		await Promise.all([
			queryClient.invalidateQueries({
				queryKey: workspaceKeys.changes(workspaceId),
			}),
			refresh(),
		]);
	};

	const push = useMutation({
		mutationFn: (message: string) =>
			pushWorkspaceChanges({ data: { id: workspaceId, message } }),
		onError: () => setNote("could not reach the workspace"),
		onSuccess: async (result) => {
			setNote(
				result.kind === "done"
					? `Pushed to ${result.branch}.`
					: result.kind === "nothing"
						? "Nothing to push: everything here is already on a remote."
						: result.message,
			);
			await settle();
		},
	});

	const discard = useMutation({
		mutationFn: () => discardWorkspaceChanges({ data: { id: workspaceId } }),
		onError: () => setNote("could not reach the workspace"),
		onSuccess: async (result) => {
			// Any row left unfolded is showing a file that may no longer exist, and a stale diff of
			// work that was just thrown away is the most misleading thing this page could show.
			setDiscarded((count) => count + 1);
			setNote(result.kind === "failed" ? result.message : "Discarded.");
			await settle();
		},
	});

	const retry = useMutation({
		mutationFn: () => retryWorkspaceRequest({ data: { id: workspaceId } }),
		onMutate: () =>
			predict({
				errorCode: undefined,
				errorMessage: undefined,
				status: "provisioning",
			}),
		onError: (_error, _input, rollback) => rollback?.(),
		onSuccess: refresh,
	});

	const destroy = useMutation({
		mutationFn: () => destroyWorkspaceRequest({ data: { id: workspaceId } }),
		onMutate: () =>
			predict({ desiredState: "destroyed", status: "destroying" }),
		onError: (_error, _input, rollback) => rollback?.(),
		onSuccess: refresh,
	});

	if (workspace === undefined) {
		return <main className="dashboard-main">Loading.</main>;
	}

	const busy = send.isPending || answer.isPending;

	// Shared by the button and the keyboard shortcut, so the two cannot diverge on what counts as
	// an empty prompt.
	function submitPrompt() {
		if (!busy && prompt.trim() !== "") {
			send.mutate(prompt);
		}
	}

	return (
		<>
			<main className="dashboard-main dashboard-main-fixed">
				<header className="centre-head">
					<div>
						<h1>{workspace.hostname}</h1>
						<p>{workspace.purpose || "No purpose supplied"}</p>
					</div>
					<div className="centre-head-actions">
						<WorkspaceBadges
							activity={workspace.activity}
							status={workspace.status}
						/>
						{workspace.desiredState === "destroyed" ? null : (
							<Button
								disabled={destroy.isPending}
								onClick={() => destroy.mutate()}
							>
								{destroy.isPending ? "Queueing" : "Destroy"}
							</Button>
						)}
					</div>
				</header>

				{!blocked ? null : (
					<section className="detail-blocked">
						<h2>Waiting for you</h2>
						<p>
							The agent has asked a question and will not continue until it is
							answered.
						</p>
					</section>
				)}

				{/* What became of the work, once the container is gone.
				    Derived from the timeline rather than stored: the push already writes the
				    branch there, and a second copy is a second thing to keep true. */}
				{!finished ? null : <Outcome workspace={workspace} />}

				{/* Only while the workspace still exists. On a destroyed one this used to say it
				    "will not be destroyed automatically" and to open a Diff tab that is not there,
				    which is advice about a container nobody can act on any more. */}
				{workspace.unsavedWork !== true || finished ? null : (
					<section className="detail-kept">
						<h2>Holding unsaved work</h2>
						<p>
							The workspace has uncommitted or unpushed changes, so it will not
							be destroyed automatically. Open the Diff tab to see what changed
							and to push or discard it.
						</p>
					</section>
				)}

				{workspace.errorMessage === undefined ? null : (
					<section className="detail-error">
						<h2>{workspace.errorCode ?? "error"}</h2>
						<p>{workspace.errorMessage}</p>
						{workspace.status !== "failed" ? null : (
							<Button disabled={retry.isPending} onClick={() => retry.mutate()}>
								{retry.isPending ? "Queueing" : "Retry"}
							</Button>
						)}
					</section>
				)}

				{!ready ? null : (
					<section className="centre-screen">
						{pane?.kind === "screen" ? (
							<AgentScreen screen={pane.text} />
						) : (
							<p className="detail-note">
								{pane?.kind === "unavailable"
									? pane.reason
									: "Reading the agent screen."}
							</p>
						)}

						{/* Always present, disabled unless the agent is waiting. Rendering it only
						    while blocked meant the row appeared and disappeared underneath the
						    pointer, shifting the prompt and the timeline with it. Disabled still
						    stops a key reaching a working agent by accident, and the controls are
						    visible before they are needed rather than only once they are. */}
						<div className="detail-keys">
							{ANSWER_KEYS.map((key) => {
								const Arrow = ARROWS[key];

								return Arrow === undefined ? (
									<Button
										disabled={busy || !blocked}
										key={key}
										onClick={() => answer.mutate(key)}
									>
										{key}
									</Button>
								) : (
									<IconButton
										disabled={busy || !blocked}
										icon={Arrow}
										key={key}
										label={key === "up" ? "Move up" : "Move down"}
										onClick={() => answer.mutate(key)}
									/>
								);
							})}
						</div>

						<form
							className="detail-prompt"
							onSubmit={(event) => {
								event.preventDefault();
								submitPrompt();
							}}
						>
							<div className="prompt-field">
								<textarea
									disabled={busy}
									onChange={(event) => setPrompt(event.target.value)}
									// Enter alone inserts a newline, because a prompt is often a
									// paragraph and losing one to a stray keystroke is worse than
									// reaching for a modifier.
									onKeyDown={(event) => {
										if (
											event.key === "Enter" &&
											(event.metaKey || event.ctrlKey)
										) {
											event.preventDefault();
											submitPrompt();
										}
									}}
									placeholder="Tell the agent what to do next"
									rows={3}
									value={prompt}
								/>
								<Button
									className="prompt-send"
									disabled={busy || prompt.trim() === ""}
									title="Send (Cmd or Ctrl + Enter)"
									type="submit"
								>
									{send.isPending ? "Sending" : "Send"}
								</Button>
							</div>
						</form>
						{note === "" ? null : <p className="detail-note">{note}</p>}
					</section>
				)}
			</main>

			<WorkspaceRail
				actions={
					!ready || changes?.kind !== "changes" ? undefined : (
						<ChangesActions
							discarding={discard.isPending}
							files={changes.files}
							note={note}
							unpushed={changes.unpushed}
							onDiscard={() => discard.mutate()}
							onPush={(message) => push.mutate(message)}
							pushing={push.isPending}
							suggestedMessage={suggestedMessage(workspace.purpose)}
						/>
					)
				}
				changes={
					!ready ? undefined : (
						<ChangesPanel
							changes={changes}
							key={discarded}
							workspaceId={workspaceId}
						/>
					)
				}
				onTab={setTab}
				tab={tab}
				terminal={<WorkspaceTerminal ready={ready} workspaceId={workspaceId} />}
				timeline={
					<div className="rail-timeline">
						<WorkspaceTimeline events={workspace.events} />
					</div>
				}
				workspace={workspace}
			/>
		</>
	);
}

// suggestedMessage turns why the workspace exists into a commit message worth keeping.
//
// The purpose is the one sentence that already describes what the agent was asked to do, so it is
// a better default than an empty box or a generic "agent changes". Still editable: it says what
// was asked for rather than what was done.
function suggestedMessage(purpose?: string): string {
	const text = purpose?.trim() ?? "";
	if (text === "") {
		return "Agent changes";
	}

	// Commit summaries are read in fixed-width lists, so a purpose running to a paragraph is cut
	// rather than allowed to set the width of every log that ever shows it.
	return text.length > 72 ? `${text.slice(0, 69)}...` : text;
}

// Outcome says where a finished workspace's work went, in one line.
//
// The container is gone and the timeline is sixteen entries long; this is the one sentence
// somebody scrolling back through a destroyed workspace actually wants.
function Outcome({
	workspace,
}: {
	workspace: Parameters<typeof workspaceOutcome>[0];
}) {
	const outcome = workspaceOutcome(workspace);
	if (outcome.kind === "nothing") {
		return null;
	}

	return (
		<section
			className={
				outcome.kind === "lost" ? "detail-kept detail-lost" : "detail-kept"
			}
		>
			<h2>{HEADINGS[outcome.kind]}</h2>
			<p>{body(outcome)}</p>
		</section>
	);
}

const HEADINGS: Record<WorkspaceOutcome["kind"], string> = {
	discarded: "Changes discarded",
	lost: "Ended holding unsaved work",
	nothing: "",
	pushed: "Work pushed",
};

function body(outcome: WorkspaceOutcome) {
	if (outcome.kind === "pushed") {
		return (
			<>
				The agent's work is on{" "}
				{outcome.url === undefined ? (
					<code>{outcome.branch}</code>
				) : (
					<a href={outcome.url} rel="noreferrer" target="_blank">
						{outcome.branch}
					</a>
				)}
				, not on the branch the workspace was cloned from. The container is
				gone; the work is not.
			</>
		);
	}
	if (outcome.kind === "discarded") {
		return "Everything in the working tree was deliberately thrown away before this workspace ended.";
	}

	return "This workspace was last seen holding uncommitted or unpushed changes. Its container has been deleted, so that work is gone.";
}
