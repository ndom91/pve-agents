import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { WorkspaceBadges } from "../components/workspace-badges";
import { WorkspaceTimeline } from "../components/workspace-timeline";
import { paneQuery, workspaceKeys, workspaceQuery } from "../lib/queries";
import {
	promptWorkspaceAgent,
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
const ANSWER_KEYS = ["1", "2", "3", "up", "down", "enter", "esc"];

function WorkspaceDetail() {
	const { workspaceId } = Route.useParams();
	const queryClient = useQueryClient();
	const { data: workspace } = useQuery(workspaceQuery(workspaceId));
	const [prompt, setPrompt] = useState("");
	const [note, setNote] = useState("");

	const ready = workspace?.status === "ready";
	const blocked = workspace?.activity === "blocked";
	const { data: pane } = useQuery(paneQuery(workspaceId, ready));

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
		onSuccess: async (result) => {
			if (result.kind === "blocked") {
				setNote("The agent is waiting for input. Answer it first.");

				return;
			}
			if (result.kind === "unavailable") {
				setNote(result.reason);

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
		onSuccess: async (result) => {
			setNote(result.kind === "unavailable" ? result.reason : "");
			await queryClient.invalidateQueries({
				queryKey: workspaceKeys.pane(workspaceId),
			});
			await refresh();
		},
	});

	const retry = useMutation({
		mutationFn: () => retryWorkspaceRequest({ data: { id: workspaceId } }),
		onSuccess: refresh,
	});

	const destroy = useMutation({
		mutationFn: () => destroyWorkspaceRequest({ data: { id: workspaceId } }),
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
			<main className="dashboard-main">
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
							<button
								disabled={destroy.isPending}
								onClick={() => destroy.mutate()}
								type="button"
							>
								{destroy.isPending ? "Queueing" : "Destroy"}
							</button>
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

				{workspace.errorMessage === undefined ? null : (
					<section className="detail-error">
						<h2>{workspace.errorCode ?? "error"}</h2>
						<p>{workspace.errorMessage}</p>
						{workspace.status !== "failed" ? null : (
							<button
								disabled={retry.isPending}
								onClick={() => retry.mutate()}
								type="button"
							>
								{retry.isPending ? "Queueing" : "Retry"}
							</button>
						)}
					</section>
				)}

				{!ready ? null : (
					<section className="centre-screen">
						{/* Terminal output from a process no operator controls, so it is rendered
						    as text and never interpreted as markup. */}
						{pane?.kind === "screen" ? (
							<pre className="detail-screen">{pane.text}</pre>
						) : (
							<p className="detail-note">
								{pane?.kind === "unavailable"
									? pane.reason
									: "Reading the agent screen."}
							</p>
						)}

						{/* Offered only while the agent is actually waiting, so they cannot be
						    fired at a working agent by accident. */}
						{!blocked ? null : (
							<div className="detail-keys">
								{ANSWER_KEYS.map((key) => (
									<button
										disabled={busy}
										key={key}
										onClick={() => answer.mutate(key)}
										type="button"
									>
										{key}
									</button>
								))}
							</div>
						)}

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
								<button
									className="prompt-send"
									disabled={busy || prompt.trim() === ""}
									title="Send (Cmd or Ctrl + Enter)"
									type="submit"
								>
									{send.isPending ? "Sending" : "Send"}
								</button>
							</div>
						</form>
						{note === "" ? null : <p className="detail-note">{note}</p>}
					</section>
				)}

				<section className="centre-timeline">
					<h2>Timeline</h2>
					<WorkspaceTimeline events={workspace.events} />
				</section>
			</main>

			<aside className="dashboard-rail">
				<p className="sidebar-label">Placement</p>
				<dl>
					<Fact label="Repository" value={workspace.repository} />
					<Fact label="Ref" value={workspace.ref} />
					<Fact label="Node" value={workspace.node} />
					<Fact label="VMID" value={workspace.vmid?.toString()} />
					<Fact label="Address" value={workspace.ip} />
					<Fact label="Phase" value={workspace.provisionPhase} />
					<Fact label="Step" value={workspace.currentStep} />
					<Fact label="Herdr session" value={workspace.herdrSession} />
					<Fact label="Herdr workspace" value={workspace.herdrWorkspaceId} />
					<Fact label="Herdr pane" value={workspace.herdrPaneId} />
					<Fact label="Created" value={workspace.createdAt?.slice(0, 19)} />
					<Fact
						label="Last active"
						value={workspace.lastActivityAt?.slice(0, 19)}
					/>
				</dl>
			</aside>
		</>
	);
}

// Fact renders one label and value, and nothing at all when there is no value yet.
function Fact({ label, value }: { label: string; value?: string }) {
	if (value === undefined || value === "") {
		return null;
	}

	return (
		<div>
			<dt>{label}</dt>
			<dd>{value}</dd>
		</div>
	);
}
