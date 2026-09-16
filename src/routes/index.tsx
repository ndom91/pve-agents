import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";

import { requestId } from "../lib/request-id";
import { sessionState } from "../server/session.functions";
import { controllerStatus } from "../server/status.functions";
import { createWorkspace, listWorkspaces } from "../server/workspace.functions";

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

function Home() {
	const { status, workspaces } = Route.useLoaderData();
	const [error, setError] = useState("");
	const [submitting, setSubmitting] = useState(false);

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
							<article key={workspace.id} className="workspace-row">
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
								<p className={`status status-${workspace.status}`}>
									{workspace.status}
								</p>
							</article>
						))}
					</div>
				)}
			</section>
		</main>
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
