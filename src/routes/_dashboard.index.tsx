import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { Button } from "../components/button";
import { Elapsed } from "../components/elapsed";
import { FleetRow } from "../components/fleet-row";
import { MetaBand } from "../components/meta-band";
import { SectionHead } from "../components/section-head";
import { shortRepository } from "../domain/repository";
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

	const destroyed = workspaces.filter(
		(workspace) => workspace.status === "destroyed",
	);

	return (
		<main className="dashboard-main dashboard-main-wide dashboard-home">
			{/* The same 48px bar the workspace page has, so the two screens start on one line. */}
			<header className="screen-bar">
				<span className="home-eyebrow">PVE / AGENTS</span>
				<span aria-hidden="true" className="home-bar-sep" />
				<h1 className="home-title">Agent compute</h1>
			</header>

			{/* What the controller will actually do with a request. Provisioning off and the worker
			    off look identical from the fleet list -- both are a workspace that sits at
			    "requested" -- and an operator otherwise has to read the journal to tell a busy
			    controller from one that is never going to start. It was a definition list floating
			    beside the page title; it is the same band the workspace page uses for placement. */}
			<MetaBand
				facts={
					status === undefined
						? []
						: [
								{
									key: "provisioning",
									tone: status.provisioningEnabled ? "on" : "off",
									value: status.provisioningEnabled ? "on" : "off",
								},
								{
									key: "worker",
									tone: status.workerEnabled ? "on" : "off",
									value: status.workerEnabled ? "on" : "off",
								},
								{
									key: "in flight",
									value: String(status.activeOperations),
								},
							]
				}
				tail={`${live.length} running \u00b7 ${destroyed.length} destroyed`}
			/>

			<div className="home-body">
				<div className="home-main">
					<section className="home-section">
						<SectionHead count={live.length} label="Running" />
						{live.length === 0 ? (
							<p className="detail-note">
								Nothing running. Every workspace is a container that exists only
								while it is useful, so an empty fleet is the resting state
								rather than a problem.
							</p>
						) : (
							<div className="fleet-table">
								<div className="fleet-head">
									<span className="fleet-what">Workspace</span>
									<span className="fleet-col is-repo">Repo</span>
									<span className="fleet-col is-where">Placement</span>
									<span className="fleet-col is-state">State</span>
									<span className="fleet-col is-up">Up</span>
									<span aria-hidden="true" className="fleet-go" />
								</div>
								{live.map((workspace) => (
									<FleetRow key={workspace.id} workspace={workspace} />
								))}
							</div>
						)}
					</section>

					{destroyed.length === 0 ? null : (
						<section className="home-section">
							<SectionHead
								count={destroyed.length}
								label="Recently destroyed"
							/>
							<div className="gone-list">
								{destroyed.slice(0, DESTROYED_SHOWN).map((workspace) => (
									<div className="gone-row" key={workspace.id}>
										<span aria-hidden="true" className="gone-dot" />
										{/* The title, not the whole row as the running fleet above does,
										    so the other cells stay selectable. */}
										<Link
											className="gone-title"
											params={{ workspaceId: workspace.id }}
											to="/workspaces/$workspaceId"
										>
											{workspace.title ?? workspace.hostname}
										</Link>
										<span className="fleet-col is-repo">
											{shortRepository(workspace.repository)}
										</span>
										<span className="fleet-col is-where">
											{workspace.node ?? ""}
										</span>
										<span className="fleet-col is-state">destroyed</span>
										<span className="fleet-col is-up">
											<Elapsed since={workspace.updatedAt} />
										</span>
										<span aria-hidden="true" className="fleet-go" />
									</div>
								))}
							</div>
						</section>
					)}
				</div>

				<div className="home-side">
					<SectionHead label="New workspace" />
					<form
						className="launch"
						onSubmit={(event) => {
							event.preventDefault();
							if (repository.trim() !== "") {
								request.mutate();
							}
						}}
					>
						<label className="launch-field">
							<span className="launch-label">Repository</span>
							<input
								onChange={(event) => setRepository(event.target.value)}
								placeholder="github.com/owner/name"
								value={repository}
							/>
						</label>

						<label className="launch-field is-ref">
							<span className="launch-label">Ref</span>
							<input
								onChange={(event) => setRef(event.target.value)}
								placeholder="main"
								value={ref}
							/>
						</label>

						<label className="launch-field">
							<span className="launch-label">
								Purpose
								<span className="launch-optional">optional</span>
							</span>
							<textarea
								onChange={(event) => setPurpose(event.target.value)}
								placeholder="What should the agent do? Sent to it verbatim once the workspace is ready."
								rows={5}
								value={purpose}
							/>
							<small className="launch-hint">
								Leave empty and the workspace comes up idle, waiting to be told
								something.
							</small>
						</label>

						<span aria-hidden="true" className="launch-rule" />

						<div className="launch-foot">
							{request.error === null ? null : (
								<p className="launch-error">
									{request.error instanceof Error
										? request.error.message
										: "workspace request failed"}
								</p>
							)}
							<Button
								className="launch-send"
								// In flight only. The submit handler already refuses an empty
								// repository, so disabling on one would paint the screen's single
								// primary action dead for as long as nobody is typing.
								disabled={request.isPending}
								type="submit"
							>
								{request.isPending ? "Requesting" : "Request workspace"}
							</Button>
						</div>
					</form>
				</div>
			</div>
		</main>
	);
}

// DESTROYED_SHOWN caps the recently-destroyed list. It is a reminder that work happened here, not
// an archive -- the sidebar holds that.
const DESTROYED_SHOWN = 5;
