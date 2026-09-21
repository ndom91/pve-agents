import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { AgentChat } from "../components/agent-chat";
import { Button } from "../components/button";
import { ChangesActions } from "../components/changes-actions";
import { ChangesPanel } from "../components/changes-panel";
import { Elapsed } from "../components/elapsed";
import { IconButton } from "../components/icon-button";
import { MetaBand } from "../components/meta-band";
import { WorkspaceBadges } from "../components/workspace-badges";
import type { RailTab } from "../components/workspace-rail";
import { WorkspaceRail } from "../components/workspace-rail";
import { WorkspaceTerminal } from "../components/workspace-terminal";
import { WorkspaceTimeline } from "../components/workspace-timeline";
import { WorkspaceTitle } from "../components/workspace-title";
import type { WorkspaceOutcome } from "../domain/workspace-outcome";
import { workspaceOutcome } from "../domain/workspace-outcome";
import { formatDuration } from "../lib/clock";
import { changesQuery, workspaceKeys, workspaceQuery } from "../lib/queries";
import { useAgentStream } from "../lib/use-agent-stream";
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

	const ready = workspace?.status === "ready";
	// Nothing can be done to it any more: no terminal, no prompt, no diff to push or discard.
	const finished =
		workspace?.status === "destroyed" || workspace?.status === "failed";
	const blocked = workspace?.activity === "blocked";

	const agent = useAgentStream(workspaceId, ready);

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
							className="screen-bar-destroy"
							disabled={destroy.isPending}
							icon={Trash2}
							label={
								destroy.isPending ? "Queueing destroy" : "Destroy workspace"
							}
							onClick={() => destroy.mutate()}
							size={12}
							strokeWidth={1.1}
							// Tertiary because it brings its own border. The secondary variant
							// sets a grey one, and a grey rule around a red glyph reads as a
							// disabled control rather than a dangerous one.
							variant="tertiary"
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
					tail={<Uptime workspace={workspace} />}
				/>

				{/* Everything the two bars sit above. The bars bleed to the column's edges, so the
				    padding that used to belong to the column belongs to this instead. */}
				<div className="screen-body">
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
								The workspace has uncommitted or unpushed changes, so it will
								not be destroyed automatically. Open the Diff tab to see what
								changed and to push or discard it.
							</p>
						</section>
					)}

					{workspace.errorMessage === undefined ? null : (
						<section className="detail-error">
							<h2>{workspace.errorCode ?? "error"}</h2>
							<p>{workspace.errorMessage}</p>
							{workspace.status !== "failed" ? null : (
								<Button
									disabled={retry.isPending}
									onClick={() => retry.mutate()}
								>
									{retry.isPending ? "Queueing" : "Retry"}
								</Button>
							)}
						</section>
					)}

					{!ready ? null : (
						<section className="centre-screen">
							<AgentChat
								approvals={agent.approvals}
								busy={busy}
								link={agent.link}
								messages={agent.messages}
								onDecide={(approvalId, behavior) =>
									decide.mutate({ approvalId, behavior })
								}
								permissionMode={agent.permissionMode}
								tail={agent.tail}
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
										<span className="prompt-foot-spacer" />
										<Button
											className="prompt-send"
											// Only while a message is actually in flight. It was
											// also disabled on an empty field, which meant the
											// page's one primary action spent almost all of its
											// life painted as a dead grey rectangle. Sending
											// nothing is already a no-op in `submitPrompt`, so
											// there is nothing for the disabled state to protect.
											disabled={busy}
											title="Send (Cmd or Ctrl + Enter)"
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
							readyIn={took(workspace.createdAt, workspace.readyAt)}
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

// Uptime is the meta band's right-hand summary: how long this container has been up.
//
// Counted from ready_at rather than created_at, because "up" means reachable and the gap between
// the two is the provision. Before a workspace is ready there is no uptime to report, so the band
// says how long it has been waiting instead -- which is the number you actually want while you are
// watching one build.
//
// Nothing at all once it is gone. A destroyed container's uptime is a number that stopped being
// true, and a band that keeps counting is a band that is lying.
function Uptime({
	workspace,
}: {
	workspace: { createdAt?: string; readyAt?: string; status: string };
}): ReactNode {
	if (workspace.status === "destroyed") {
		return null;
	}

	if (workspace.readyAt !== undefined) {
		return (
			<>
				up <Elapsed of="uptime" since={workspace.readyAt} />
			</>
		);
	}

	return (
		<>
			waiting <Elapsed of="uptime" since={workspace.createdAt} />
		</>
	);
}

// took is how long provisioning ran, for the timeline's header.
//
// Undefined rather than "0s" when there is no ready_at: it was never written before it was plumbed
// in, and every workspace older than that would otherwise claim to have been built instantly.
function took(createdAt?: string, readyAt?: string): string | undefined {
	if (createdAt === undefined || readyAt === undefined) {
		return undefined;
	}

	return formatDuration(Date.parse(readyAt) - Date.parse(createdAt));
}
