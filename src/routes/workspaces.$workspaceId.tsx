import {
	createFileRoute,
	Link,
	redirect,
	useRouter,
} from "@tanstack/react-router";
import { useEffect, useState } from "react";

import {
	promptWorkspaceAgent,
	sendWorkspaceKeys,
	workspacePane,
} from "../server/agent.functions";
import { sessionState } from "../server/session.functions";
import {
	retryWorkspaceRequest,
	workspaceDetail,
} from "../server/workspace.functions";

export const Route = createFileRoute("/workspaces/$workspaceId")({
	beforeLoad: async () => {
		const state = await sessionState();
		if (state.required && !state.signedIn) {
			throw redirect({ to: "/login" });
		}
	},
	component: WorkspaceDetail,
	loader: async ({ params }) =>
		workspaceDetail({ data: { id: params.workspaceId } }),
});

// Matches the fleet view, so a step lands on screen within about one worker tick.
const REFRESH_MS = 2500;

// The screen is refreshed far less often than the record. Every read is an SSH connection to the
// workspace, and a terminal that changed in the last second will still have changed in five.
const SCREEN_REFRESH_MS = 5000;

function WorkspaceDetail() {
	const workspace = Route.useLoaderData();
	const router = useRouter();
	const [screen, setScreen] = useState("");
	const [screenError, setScreenError] = useState("");
	const [prompt, setPrompt] = useState("");
	const [sending, setSending] = useState(false);
	const [inputNote, setInputNote] = useState("");

	const settled =
		workspace.status === "destroyed" || workspace.status === "failed";

	// A ready workspace has no outstanding operation but its agent still changes, so unlike the
	// fleet view this polls on status rather than on queued work. Only a finished workspace stops.
	useEffect(() => {
		if (settled) {
			return;
		}

		const timer = setInterval(() => {
			if (document.visibilityState === "visible") {
				router.invalidate();
			}
		}, REFRESH_MS);

		return () => clearInterval(timer);
	}, [router, settled]);

	const id = workspace.id;
	const ready = workspace.status === "ready";

	useEffect(() => {
		if (!ready) {
			return;
		}

		let current = true;
		const read = async () => {
			if (document.visibilityState !== "visible") {
				return;
			}

			const pane = await workspacePane({ data: { id } }).catch(() => ({
				kind: "unavailable" as const,
				reason: "could not reach the controller",
			}));
			// The component can unmount mid-request, and a slow SSH read landing afterwards would
			// otherwise set state on something that is gone.
			if (!current) {
				return;
			}

			setScreen(pane.kind === "screen" ? pane.text : "");
			setScreenError(pane.kind === "screen" ? "" : pane.reason);
		};

		void read();
		const timer = setInterval(read, SCREEN_REFRESH_MS);

		return () => {
			current = false;
			clearInterval(timer);
		};
	}, [id, ready]);

	async function send(
		action: () => Promise<{ kind: string; reason?: string }>,
	) {
		setSending(true);
		setInputNote("");
		try {
			const result = await action();
			if (result.kind === "blocked") {
				setInputNote("The agent is waiting for input. Answer it first.");
			} else if (result.kind === "unavailable") {
				setInputNote(result.reason ?? "could not reach the agent");
			} else {
				setPrompt("");
				router.invalidate();
			}
		} catch {
			setInputNote("could not reach the controller");
		} finally {
			setSending(false);
		}
	}

	const blocked = workspace.activity === "blocked";

	return (
		<main className="detail">
			<nav>
				<Link to="/">Back to fleet</Link>
			</nav>

			<header>
				<h1>{workspace.repository}</h1>
				<p className="workspace-purpose">
					{workspace.purpose || "No purpose supplied"}
				</p>
				<p className="badges">
					<span className={`status status-${workspace.status}`}>
						{workspace.status}
					</span>
					<span className={`activity activity-${workspace.activity}`}>
						{workspace.activity}
					</span>
				</p>
			</header>

			{workspace.errorMessage === undefined ? null : (
				<section className="detail-error">
					<h2>{workspace.errorCode ?? "error"}</h2>
					<p>{workspace.errorMessage}</p>
					{workspace.status !== "failed" ? null : (
						<button
							disabled={sending}
							onClick={() =>
								send(async () => {
									await retryWorkspaceRequest({ data: { id } });

									return { kind: "sent" };
								})
							}
							type="button"
						>
							{sending ? "Queueing" : "Retry"}
						</button>
					)}
				</section>
			)}

			{!blocked ? null : (
				<section className="detail-blocked">
					<h2>Waiting for you</h2>
					<p>
						The agent has asked a question and will not continue until it is
						answered.
					</p>
				</section>
			)}

			<section>
				<h2>Placement</h2>
				<dl className="detail-facts">
					<Fact label="Host" value={workspace.hostname} />
					<Fact label="Ref" value={workspace.ref} />
					<Fact label="Node" value={workspace.node} />
					<Fact label="VMID" value={workspace.vmid?.toString()} />
					<Fact label="Address" value={workspace.ip} />
					<Fact label="Phase" value={workspace.provisionPhase} />
					<Fact label="Herdr session" value={workspace.herdrSession} />
					<Fact label="Herdr workspace" value={workspace.herdrWorkspaceId} />
					<Fact label="Herdr pane" value={workspace.herdrPaneId} />
					<Fact label="Step" value={workspace.currentStep} />
				</dl>
			</section>

			{!ready ? null : (
				<section>
					<h2>Agent screen</h2>
					{screenError === "" ? null : (
						<p className="detail-note">{screenError}</p>
					)}
					{/* Terminal output from a process no operator controls, so it is rendered as
					    text and never interpreted as markup. */}
					{screen === "" ? null : <pre className="detail-screen">{screen}</pre>}

					{/* Keys are offered only when the agent is actually waiting, so they cannot be
					    fired at a working agent by accident. */}
					{!blocked ? null : (
						<div className="detail-keys">
							{["1", "2", "3", "up", "down", "enter", "esc"].map((key) => (
								<button
									disabled={sending}
									key={key}
									onClick={() =>
										send(() => sendWorkspaceKeys({ data: { id, key } }))
									}
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
							if (prompt.trim() !== "") {
								void send(() =>
									promptWorkspaceAgent({ data: { id, text: prompt } }),
								);
							}
						}}
					>
						<textarea
							disabled={sending}
							onChange={(event) => setPrompt(event.target.value)}
							placeholder="Tell the agent what to do next"
							rows={3}
							value={prompt}
						/>
						<button disabled={sending || prompt.trim() === ""} type="submit">
							{sending ? "Sending" : "Send"}
						</button>
					</form>
					{inputNote === "" ? null : <p className="detail-note">{inputNote}</p>}
				</section>
			)}

			<section>
				<h2>Timeline</h2>
				<ol className="detail-timeline">
					{workspace.events.map((event) => (
						<li
							className={isProblem(event.eventType) ? "log-problem" : undefined}
							key={event.id}
						>
							<time dateTime={event.createdAt}>
								{event.createdAt.slice(11, 19)}
							</time>
							<span className="log-type">
								{event.eventType.replace("workspace.", "")}
							</span>
							<span>{event.message}</span>
						</li>
					))}
				</ol>
			</section>
		</main>
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

function isProblem(eventType: string): boolean {
	return (
		eventType.includes("failed") ||
		eventType.includes("retrying") ||
		eventType.includes("halted")
	);
}
