import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { Button } from "../components/button";
import { FleetCard } from "../components/fleet-card";
import { fleetQuery, statusQuery, workspaceKeys } from "../lib/queries";
import { requestId } from "../lib/request-id";
import { createWorkspace } from "../server/workspace.functions";

export const Route = createFileRoute("/_dashboard/")({
	component: Dashboard,
});

function Dashboard() {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const [repository, setRepository] = useState("");
	const [ref, setRef] = useState("main");
	const [purpose, setPurpose] = useState("");

	const { data: workspaces = [] } = useQuery(fleetQuery());
	const { data: status } = useQuery(statusQuery());

	const live = workspaces.filter(
		(workspace) => workspace.status !== "destroyed",
	);

	const request = useMutation({
		mutationFn: () =>
			createWorkspace({
				data: {
					idempotencyKey: requestId(),
					purpose: purpose.trim() === "" ? undefined : purpose.trim(),
					ref: ref.trim() === "" ? "main" : ref.trim(),
					repository: repository.trim(),
				},
			}),
		// The sidebar reads the same key, so refreshing it here is what makes the new workspace
		// appear there before its first poll would have.
		onSuccess: async (created) => {
			await queryClient.invalidateQueries({ queryKey: workspaceKeys.list() });
			navigate({
				params: { workspaceId: created.workspace.id },
				to: "/workspaces/$workspaceId",
			});
		},
	});

	return (
		<main className="dashboard-main dashboard-main-wide dashboard-home">
			<header className="home-head">
				<div>
					<p className="eyebrow">PVE / HERDR</p>
					<h1>Agent compute</h1>
				</div>
				{/* What the controller will actually do with a request. Provisioning off and the
				    worker off look identical from the fleet list — both are a workspace that sits
				    at "requested" — and an operator otherwise has to read the journal to tell the
				    difference between a busy controller and one that is never going to start. */}
				{status === undefined ? null : (
					<dl className="home-status">
						<Health
							label="Provisioning"
							ok={status.provisioningEnabled}
							value={status.provisioningEnabled ? "on" : "off"}
						/>
						<Health
							label="Worker"
							ok={status.workerEnabled}
							value={status.workerEnabled ? "on" : "off"}
						/>
						<Health
							label="In flight"
							ok
							value={String(status.activeOperations)}
						/>
					</dl>
				)}
			</header>

			<section className="home-fleet">
				<h2>
					Running
					{live.length === 0 ? null : (
						<span className="home-count">{live.length}</span>
					)}
				</h2>

				{live.length === 0 ? (
					<p className="detail-note">
						Nothing running. Every workspace is a container that exists only
						while it is useful, so an empty fleet is the resting state rather
						than a problem.
					</p>
				) : (
					<div className="fleet-grid">
						{live.map((workspace) => (
							<FleetCard key={workspace.id} workspace={workspace} />
						))}
					</div>
				)}
			</section>

			<section className="home-request">
				<h2>New workspace</h2>
				<form
					className="home-form"
					onSubmit={(event) => {
						event.preventDefault();
						if (repository.trim() !== "") {
							request.mutate();
						}
					}}
				>
					<label className="empty-field">
						<span>Repository</span>
						<input
							onChange={(event) => setRepository(event.target.value)}
							placeholder="github.com/owner/name"
							value={repository}
						/>
					</label>

					<label className="empty-field">
						<span>Ref</span>
						<input
							onChange={(event) => setRef(event.target.value)}
							placeholder="main"
							value={ref}
						/>
					</label>

					<label className="empty-field home-purpose">
						<span>Purpose</span>
						<textarea
							onChange={(event) => setPurpose(event.target.value)}
							placeholder="What should the agent do? Sent to it verbatim once the workspace is ready."
							rows={3}
							value={purpose}
						/>
						<small>
							Leave empty and the workspace comes up idle, waiting to be told
							something.
						</small>
					</label>

					<Button
						disabled={request.isPending || repository.trim() === ""}
						type="submit"
					>
						{request.isPending ? "Requesting" : "Request workspace"}
					</Button>

					{request.error === null ? null : (
						<p className="detail-note">
							{request.error instanceof Error
								? request.error.message
								: "workspace request failed"}
						</p>
					)}
				</form>
			</section>
		</main>
	);
}

// Health is one controller fact, marked when it is the answer that stops work happening.
function Health({
	label,
	ok,
	value,
}: {
	label: string;
	ok: boolean;
	value: string;
}) {
	return (
		<div className={ok ? "home-health" : "home-health is-off"}>
			<dt>{label}</dt>
			<dd>{value}</dd>
		</div>
	);
}
