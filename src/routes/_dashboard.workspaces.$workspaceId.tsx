import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Trash2 } from "lucide-react";
import { useState } from "react";
import { AgentConversation } from "../components/agent-conversation";
import { Button } from "../components/button";
import { ChangesActions } from "../components/changes-actions";
import { ChangesPanel } from "../components/changes-panel";
import { IconButton } from "../components/icon-button";
import { MetaBand } from "../components/meta-band";
import { Notice, type NoticeProps, NoticeStack } from "../components/notice";
import { outcomeItem } from "../components/outcome-notice";
import { Uptime } from "../components/uptime";
import { WorkspaceBadges } from "../components/workspace-badges";
import type { RailTab } from "../components/workspace-rail";
import { WorkspaceRail } from "../components/workspace-rail";
import { WorkspaceTerminal } from "../components/workspace-terminal";
import { WorkspaceTimeline } from "../components/workspace-timeline";
import { WorkspaceTitle } from "../components/workspace-title";
import { isConversing } from "../domain/workspace-lifecycle";
import { provisionTook } from "../lib/clock";
import { changesQuery, workspaceKeys, workspaceQuery } from "../lib/queries";
import { useOptimisticWorkspace } from "../lib/use-optimistic-workspace";
import {
	answerWorkspaceApproval,
	discardWorkspaceChanges,
	promptWorkspaceAgent,
	pushWorkspaceChanges,
} from "../server/agent.functions";
import {
	destroyWorkspaceRequest,
	renameWorkspaceTitle,
	retryWorkspaceRequest,
} from "../server/workspace.functions";
import { workspaceBranch } from "../services/workspace-changes";

export const Route = createFileRoute("/_dashboard/workspaces/$workspaceId")({
	component: WorkspaceDetail,
	loader: ({ context, params }) =>
		context.queryClient.ensureQueryData(workspaceQuery(params.workspaceId)),
});

function WorkspaceDetail() {
	const { workspaceId } = Route.useParams();
	const queryClient = useQueryClient();
	const { data: workspace } = useQuery(workspaceQuery(workspaceId));
	const [prompt, setPrompt] = useState("");
	// Two, because both panels render one. A single slot put "could not reach the agent" under the
	// Diff tab's push controls, where it read as a push that went wrong.
	const [agentNote, setAgentNote] = useState("");
	const [changesNote, setChangesNote] = useState("");
	const [tab, setTab] = useState<RailTab>({ kind: "details" });
	// Bumped when work is discarded, and used as the change list's key so it remounts collapsed.
	// A row left unfolded over a file that has just been thrown away is showing a diff of nothing.
	const [discarded, setDiscarded] = useState(0);
	// Whether the unsaved-work strip has been dismissed this visit. Not persisted: it is a live
	// condition, and a dismissal that outlived a reload would hide something still true from
	// somebody who has not read it.
	const [dismissedHold, setDismissedHold] = useState(false);

	const ready = workspace?.status === "ready";
	// The transcript outlives being able to add to it. Why, and why it is not `ready`, is in
	// `isConversing`.
	const conversing = isConversing(workspace?.status);
	// Nothing can be done to it any more: no terminal, no prompt, no diff to push or discard.
	const finished =
		workspace?.status === "destroyed" || workspace?.status === "failed";
	const blocked = workspace?.activity === "blocked";

	// Gated on the tab, not merely on the workspace: each fetch is an SSH connection, and polling
	// one for a panel nobody has opened would cost a connection every fifteen seconds for nothing.
	//
	// Any tab but Details counts. The actions sit under the diff, and the terminal and timeline are
	// both places somebody goes to decide whether there is anything worth keeping.
	const { data: changes } = useQuery(
		changesQuery(workspaceId, ready && tab.kind !== "details"),
	);

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
			setAgentNote("could not reach the agent");
		},
		onSuccess: async (result, _text, rollback) => {
			// Accepted-but-refused still has to put the prediction back: the agent is not working,
			// it is waiting.
			if (result.kind !== "sent") {
				rollback?.();
				setAgentNote(result.reason);

				return;
			}

			setPrompt("");
			setAgentNote("");
			await refresh();
		},
	});

	// The decision the runner is genuinely suspended on. Answering it releases a promise inside
	// the SDK, which is why this predicts the agent back to work: allowed or declined, the turn
	// resumes either way, because a denial goes to the model as a message it can act on.
	const decide = useMutation({
		mutationFn: (choice: { approvalId: string; behavior: "allow" | "deny" }) =>
			answerWorkspaceApproval({ data: { ...choice, id: workspaceId } }),
		onMutate: () => predict({ activity: "active" }),
		onError: async (_error, _choice, rollback) => {
			rollback?.();
			setAgentNote("could not reach the agent");
		},
		onSuccess: async (result, _choice, rollback) => {
			if (result.kind !== "sent") {
				rollback?.();
			}
			setAgentNote(result.kind === "unavailable" ? result.reason : "");
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
		onError: () => setChangesNote("could not reach the workspace"),
		onSuccess: async (result) => {
			setChangesNote(
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
		onError: () => setChangesNote("could not reach the workspace"),
		onSuccess: async (result) => {
			// Any row left unfolded is showing a file that may no longer exist, and a stale diff of
			// work that was just thrown away is the most misleading thing this page could show.
			setDiscarded((count) => count + 1);
			setChangesNote(result.kind === "failed" ? result.message : "Discarded.");
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

	// Optimistic, so the heading and the sidebar change together on the click rather than a round
	// trip later, and roll back as one if the write fails.
	const rename = useMutation({
		mutationFn: (title: string) =>
			renameWorkspaceTitle({ data: { id: workspaceId, title } }),
		onMutate: (title: string) => predict({ title: title.trim() }),
		onError: (_error, _title, rollback) => rollback?.(),
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

	const busy = send.isPending || decide.isPending;
	// Whether a prompt can be sent. Separate from `conversing` above: during a destroy the
	// transcript stays up to be read, and the field under it stops taking anything.
	const promptable = ready && !busy;

	// Everything currently true about this workspace that belongs in the header. `NoticeStack`
	// ranks them and hides all but the loudest.
	const strips: NoticeProps[] = [
		...(blocked
			? [
					{
						lead: "Waiting for you",
						// No action. The allow and deny buttons are in the feed, on the question
						// they answer, and a second copy up here is a second place to answer from.
						rest: "the agent has asked a question and will not continue until it is answered.",
						severity: "amber" as const,
					},
				]
			: []),
		...(workspace.unsavedWork === true && !finished && !dismissedHold
			? [
					{
						action: {
							label: "Open diff",
							onClick: () => setTab({ kind: "diff" }),
						},
						lead: "Holding unsaved work",
						// The one notice here worth dismissing. It is true for as long as the work
						// is unpushed, which can be all day, and an operator who has read it and
						// decided to leave the work there does not need telling again. Blocked and
						// the error do not get one: hiding a thing that is waiting on you, or the
						// reason a workspace failed, is hiding the point of the page.
						onDismiss: () => setDismissedHold(true),
						rest: "uncommitted changes, so this workspace will not be destroyed automatically.",
						severity: "amber" as const,
					},
				]
			: []),
	];

	// What became of the work, once the container is gone. A band item rather than a strip: there
	// is nothing to do about any of it. Derived from the timeline rather than stored, because the
	// push already writes the branch there.
	const outcome = finished ? outcomeItem(workspace) : [];

	// Shared by the button and the keyboard shortcut, so the two cannot diverge on what counts as
	// an empty prompt.
	function submitPrompt() {
		if (promptable && prompt.trim() !== "") {
			send.mutate(prompt);
		}
	}

	return (
		<>
			<main className="dashboard-main dashboard-main-fixed">
				{/* One 48px row: what this is, then what state it is in, then the one thing you
				    can do to it. The title and the purpose used to stack on the left with the
				    controls floating opposite, which spent two rows and left the purpose
				    competing with the heading it explains. */}
				<header className="screen-bar">
					<WorkspaceTitle
						hostname={workspace.hostname}
						onRename={(title) => rename.mutate(title)}
						title={workspace.title}
					/>
					<span aria-hidden="true" className="screen-bar-tick" />
					<p className="screen-bar-purpose">
						{workspace.purpose || "No purpose supplied"}
					</p>
					<WorkspaceBadges
						activity={workspace.activity}
						status={workspace.status}
						variant="group"
					/>
					{/* Outlined in red, never the accent fill. It was the brightest thing on the
					    page, which made the one irreversible action the most attractive. */}
					{workspace.desiredState === "destroyed" ? null : (
						<IconButton
							disabled={destroy.isPending}
							icon={Trash2}
							label={
								destroy.isPending ? "Queueing destroy" : "Destroy workspace"
							}
							onClick={() => destroy.mutate()}
							size={12}
							strokeWidth={1.1}
							variant="danger"
						/>
					)}
				</header>

				{/* Placement, on screen whether or not the panel is open. */}
				<MetaBand
					facts={[
						{ key: "node", value: workspace.node },
						{ key: "vmid", value: workspace.vmid?.toString() },
						{ key: "addr", value: workspace.ip },
						{
							key: "branch",
							value:
								workspace.hostname === undefined
									? undefined
									: workspaceBranch(workspace.hostname),
						},
					]}
					notices={outcome}
					tail={<Uptime workspace={workspace} />}
				/>

				{/* Outside the column's padding, deliberately. A strip belongs to the same register
				    as the band above it, and `screen-body` would inset it by 28px and make it read
				    as the first message in the feed. */}
				<NoticeStack notices={strips} />

				{/* Everything the two bars sit above. The bars bleed to the column's edges, so the
				    padding that used to belong to the column belongs to this instead. */}
				<div className="screen-body">
					{/* A block rather than a strip, on both of the counts that earn one: the message
					    runs past a line, and Retry is a real choice. A strip would ellipsise the
					    only place the failure is written down. */}
					{workspace.errorMessage === undefined ? null : (
						<Notice
							action={
								workspace.status === "failed"
									? {
											label: retry.isPending ? "Queueing" : "Retry",
											onClick: () => retry.mutate(),
										}
									: undefined
							}
							lead={workspace.errorCode ?? "error"}
							placement="block"
							rest={workspace.errorMessage}
							severity="red"
						/>
					)}

					{!conversing ? null : (
						<section className="centre-screen">
							<AgentConversation
								busy={busy}
								onDecide={(approvalId, behavior) =>
									decide.mutate({ approvalId, behavior })
								}
								workspaceId={workspaceId}
							/>

							<form
								className="detail-prompt"
								onSubmit={(event) => {
									event.preventDefault();
									submitPrompt();
								}}
							>
								<div className="prompt-field">
									<textarea
										disabled={!promptable}
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
										// Two rows to start in, growing with what is typed --
										// see `field-sizing` and `min-height` in the stylesheet.
										// This attribute is the floor for a browser that does not
										// support the former.
										rows={2}
										value={prompt}
									/>
									{/* The two keys that do something here, written as the glyphs
									    they are printed on. The send button no longer floats over
									    the field -- it sits on this row, which is what gives the
									    hints somewhere to be. */}
									<div className="prompt-foot">
										<span className="prompt-hint">
											<kbd className="prompt-key">&#8984;&#8629;</kbd> send
										</span>
										<span className="prompt-hint">
											<kbd className="prompt-key">&#8679;&#8629;</kbd> newline
										</span>
										<span className="spacer" />
										<Button
											className="prompt-send"
											// In flight, or the workspace can no longer take one. Not
											// on an empty field, which painted the page's one
											// primary action grey for most of its life; sending
											// nothing is already a no-op in `submitPrompt`.
											disabled={!promptable}
											tooltip="Send (Cmd or Ctrl + Enter)"
											type="submit"
										>
											{send.isPending ? "Sending" : "Send"}
										</Button>
									</div>
								</div>
							</form>
							{agentNote === "" ? null : (
								<p className="detail-note">{agentNote}</p>
							)}
						</section>
					)}
				</div>
			</main>

			<WorkspaceRail
				actions={
					!ready || changes?.kind !== "changes" ? undefined : (
						<ChangesActions
							discarding={discard.isPending}
							files={changes.files}
							note={changesNote}
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
							against={workspace.ref}
							changes={changes}
							key={discarded}
							workspaceId={workspaceId}
						/>
					)
				}
				onTab={setTab}
				tab={tab}
				terminal={
					<WorkspaceTerminal
						hostname={workspace.hostname}
						ip={workspace.ip}
						ready={ready}
						workspaceId={workspaceId}
					/>
				}
				timeline={
					<div className="rail-timeline">
						<WorkspaceTimeline
							events={workspace.events}
							readyIn={provisionTook(workspace.createdAt, workspace.readyAt)}
						/>
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
