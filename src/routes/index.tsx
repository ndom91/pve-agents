import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { requestId } from "../lib/request-id";
import { sessionState } from "../server/session.functions";
import { controllerStatus } from "../server/status.functions";
import {
	createWorkspace,
	destroyWorkspaceRequest,
	listWorkspaces,
} from "../server/workspace.functions";
import type { FleetWorkspace } from "../services/workspace-service";

export const Route = createFileRoute("/")({
	// Runs on every navigation, including client-side <Link> transitions, so a session that
	// expires mid-visit redirects rather than leaving a dead page behind.
	beforeLoad: async () => {
		const state = await sessionState();
		if (state.required && !state.signedIn) {
			throw redirect({ to: "/login" });
		}
	},
	component: Home,
	loader: async () => ({
		status: await controllerStatus(),
		workspaces: await listWorkspaces(),
	}),
});

// Half the worker interval, so a step is on screen within about one tick of happening.
const REFRESH_MS = 2500;

function Home() {
	const { status, workspaces } = Route.useLoaderData();
	const router = useRouter();

	// The worker advances one step every few seconds, so the page follows it by refetching rather
	// than holding a connection open. It runs only while work is outstanding and only while the
	// tab is visible, so a settled fleet polls nothing.
	useEffect(() => {
		if (status.activeOperations === 0) {
			return;
		}

		const timer = setInterval(() => {
			if (document.visibilityState === "visible") {
				router.invalidate();
			}
		}, REFRESH_MS);

		return () => clearInterval(timer);
	}, [router, status.activeOperations]);
	const [error, setError] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [destroying, setDestroying] = useState("");

	async function destroy(id: string) {
		setError("");
		setDestroying(id);

		try {
			await destroyWorkspaceRequest({ data: { id } });
			await router.invalidate();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "destroy failed");
		} finally {
			setDestroying("");
		}
	}

	async function submit(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setError("");
		setSubmitting(true);

		const form = new FormData(event.currentTarget);
		const repository = form.get("repository");
		const ref = form.get("ref");
		const purpose = form.get("purpose");
		if (typeof repository !== "string" || typeof ref !== "string") {
			setError("repository and ref are required");
			setSubmitting(false);

			return;
		}

		const purposeText = optionalText(purpose);

		try {
			await createWorkspace({
				data: {
					idempotencyKey: requestId(),
					purpose: purposeText,
					repository,
					ref,
				},
			});
			window.location.reload();
		} catch (cause) {
			const message =
				cause instanceof Error ? cause.message : "workspace request failed";

			setError(message);
			setSubmitting(false);
		}
	}

	return (
		<main className="shell">
			<header className="masthead">
				<div>
					<p className="eyebrow">PVE / HERDR</p>
					<h1>Agent compute</h1>
				</div>
				<p className="mode">
					{status.provisioningEnabled
						? status.workerEnabled
							? "Provisioning enabled"
							: "Provisioning enabled · worker off"
						: "Provisioning disabled"}
				</p>
			</header>

			<section className="request-panel" aria-labelledby="request-title">
				<div>
					<p className="eyebrow">NEW TASK</p>
					<h2 id="request-title">Request a disposable workspace</h2>
				</div>
				<form onSubmit={submit}>
					<label>
						Repository
						<input
							name="repository"
							placeholder="git@github.com:plainhq/plain.git"
							required
						/>
					</label>
					<label>
						Ref
						<input defaultValue="main" name="ref" required />
					</label>
					<label className="wide">
						Purpose
						<input
							name="purpose"
							placeholder="Investigate round-robin race condition"
						/>
					</label>
					<button disabled={submitting} type="submit">
						{submitting ? "Saving request" : "Queue workspace"}
					</button>
				</form>
				{error === "" ? null : <p className="error">{error}</p>}
			</section>

			<section className="workspace-panel" aria-labelledby="workspace-title">
				<div className="section-heading">
					<div>
						<p className="eyebrow">FLEET</p>
						<h2 id="workspace-title">Workspace requests</h2>
					</div>
					<p>{workspaces.length} total</p>
				</div>
				{workspaces.length === 0 ? (
					<p className="empty">
						No workspace requests yet. The controller is ready for a first task.
					</p>
				) : (
					<div className="workspace-list">
						{workspaces.map((workspace) => (
							<WorkspaceRow
								destroying={destroying === workspace.id}
								key={workspace.id}
								onDestroy={destroy}
								workspace={workspace}
							/>
						))}
					</div>
				)}
			</section>
		</main>
	);
}

// WorkspaceRow renders one workspace and its timeline.
function WorkspaceRow({
	destroying,
	onDestroy,
	workspace,
}: {
	destroying: boolean;
	onDestroy: (id: string) => void;
	workspace: FleetWorkspace;
}) {
	return (
		<article className="workspace-row">
			<div>
				<p className="workspace-name">{workspace.repository}</p>
				<p className="workspace-purpose">
					{workspace.purpose || "No purpose supplied"}
				</p>
			</div>
			<dl>
				<div>
					<dt>Ref</dt>
					<dd>{workspace.ref}</dd>
				</div>
				<div>
					<dt>Host</dt>
					<dd>{workspace.hostname}</dd>
				</div>
			</dl>
			<div className="workspace-actions">
				<p className={`status status-${workspace.status}`}>
					{workspace.status}
				</p>
				{workspace.desiredState === "destroyed" ? null : (
					<button
						disabled={destroying}
						onClick={() => onDestroy(workspace.id)}
						type="button"
					>
						{destroying ? "Queueing" : "Destroy"}
					</button>
				)}
			</div>
			{workspace.events.length === 0 ? null : (
				<details className="workspace-logs">
					<summary>
						Logs
						<span>{workspace.events.length}</span>
					</summary>
					<ol>
						{workspace.events.map((event) => (
							<li
								className={
									isProblem(event.eventType) ? "log-problem" : undefined
								}
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
				</details>
			)}
		</article>
	);
}

// isProblem marks the timeline entries an operator needs to notice.
function isProblem(eventType: string): boolean {
	return (
		eventType.includes("failed") ||
		eventType.includes("halted") ||
		eventType === "workspace.retrying"
	);
}

function optionalText(value: FormDataEntryValue | null): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}

	const text = value.trim();
	if (text === "") {
		return undefined;
	}

	return text;
}
