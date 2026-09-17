import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { workspaceKeys } from "../lib/queries";
import { requestId } from "../lib/request-id";
import { createWorkspace } from "../server/workspace.functions";

export const Route = createFileRoute("/_dashboard/")({
	component: NewWorkspace,
});

function NewWorkspace() {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const [repository, setRepository] = useState("");
	const [ref, setRef] = useState("main");
	const [purpose, setPurpose] = useState("");

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
		<main className="dashboard-main dashboard-main-wide empty-state">
			<form
				className="empty-card"
				onSubmit={(event) => {
					event.preventDefault();
					if (repository.trim() !== "") {
						request.mutate();
					}
				}}
			>
				<header>
					<h1>New workspace</h1>
					<p>
						Clones the repository into a fresh container, starts an agent in it,
						and gives that agent the purpose below.
					</p>
				</header>

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

				<label className="empty-field">
					<span>Purpose</span>
					<textarea
						onChange={(event) => setPurpose(event.target.value)}
						placeholder="What should the agent do? Sent to it verbatim once the workspace is ready."
						rows={4}
						value={purpose}
					/>
					<small>
						Leave empty and the workspace comes up idle, waiting to be told
						something.
					</small>
				</label>

				<button
					disabled={request.isPending || repository.trim() === ""}
					type="submit"
				>
					{request.isPending ? "Requesting" : "Request workspace"}
				</button>

				{request.error === null ? null : (
					<p className="detail-note">
						{request.error instanceof Error
							? request.error.message
							: "workspace request failed"}
					</p>
				)}
			</form>
		</main>
	);
}
