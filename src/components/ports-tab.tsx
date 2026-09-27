import { useMutation, useQuery } from "@tanstack/react-query";
import { ExternalLink, RotateCw, Share2, Square } from "lucide-react";
import { type ReactNode, useState } from "react";

import { portUrl, shortCwd } from "../domain/port";
import { AGENT_CWD } from "../domain/workspace-layout";
import { portsQuery } from "../lib/queries";
import { forwardPort, stopPort } from "../server/agent.functions";
import { IconButton } from "./icon-button";
import { PanelNote, PanelSpinner } from "./panel-state";
import { Tooltip } from "./tooltip";

// PortsTab is what is listening inside the workspace, and how to open it.
//
// Modelled on the editor panel of the same name: the point is to answer "the dev server is up, now
// what is its address" without anybody opening a shell to run `ss` themselves.
export function PortsTab({ workspaceId }: { workspaceId: string }): ReactNode {
	const { data, isFetching, refetch } = useQuery(portsQuery(workspaceId));
	const [note, setNote] = useState("");

	// Both re-read the list rather than patching it in place. The listing and the set of forwards
	// are one answer from the server, and rebuilding half of it here is how a Stop button appears
	// over a tunnel that has already died.
	const forward = useMutation({
		mutationFn: (port: number) =>
			forwardPort({ data: { id: workspaceId, port } }),
		onSuccess: async (result) => {
			setNote(result.kind === "unavailable" ? result.reason : "");
			await refetch();
		},
	});
	const stop = useMutation({
		mutationFn: (port: number) => stopPort({ data: { id: workspaceId, port } }),
		onSuccess: async () => {
			setNote("");
			await refetch();
		},
	});
	const busy = forward.isPending || stop.isPending;

	if (data === undefined) {
		return <PanelSpinner label="Reading the listening ports." />;
	}
	if (data.kind === "unavailable") {
		return <PanelNote>{data.message}</PanelNote>;
	}
	if (data.ports.length === 0) {
		// Worth saying what was excluded. Otherwise an empty tab on a container that is plainly
		// running sshd reads as the tab being broken.
		return (
			<PanelNote>
				Nothing the agent started is listening. System services are not shown.
			</PanelNote>
		);
	}

	return (
		<div className="ports">
			<div className="ports-head">
				<span className="ports-count">{data.ports.length} listening</span>
				<IconButton
					disabled={isFetching}
					icon={RotateCw}
					label="Refresh"
					size={14}
					onClick={() => void refetch()}
					variant="tertiary"
				/>
			</div>

			<ul className="ports-list">
				{data.ports.map((port) => (
					<li className="ports-row" key={port.port}>
						<span className="ports-port">
							{port.port}
							{/* The allocated one after it, muted. The first number is what the dev
							    server's own logs say and what its config set; the second is an
							    implementation detail of reaching it, and reads as one. */}
							{port.forwarded === undefined ? null : (
								<span className="ports-forwarded"> ({port.forwarded})</span>
							)}
						</span>
						<span className="ports-process">{port.process}</span>
						{/* The directory the server was started in, which is how somebody tells two
						    Vite servers apart. Absent when /proc could not be read, and then the
						    column is simply empty rather than filled with a guess. */}
						<span className="ports-cwd">
							{port.cwd === undefined ? "" : shortCwd(port.cwd, AGENT_CWD)}
						</span>
						{port.reach === "loopback" && port.forwarded === undefined ? (
							// Nothing to open yet. The forward is the step that gives this row the
							// same button every other row already has.
							<IconButton
								disabled={busy}
								icon={Share2}
								label={`Forward ${port.port} to this controller`}
								size={14}
								onClick={() => forward.mutate(port.port)}
								variant="tertiary"
							/>
						) : null}
						{port.reach === "direct" || port.forwarded !== undefined ? (
							// A real anchor wearing the icon button's clothes, rather than a button
							// that calls window.open. It looks identical and keeps everything a
							// link gives for free: cmd-click, middle-click, and "copy link
							// address" for pasting somewhere else.
							<Tooltip label={`Open ${openAt(data, port)}`}>
								<a
									className="icon-button is-tertiary"
									href={openAt(data, port)}
									rel="noreferrer"
									target="_blank"
								>
									<ExternalLink aria-hidden size={14} strokeWidth={1.75} />
									<span className="visually-hidden">
										Open port {port.port} in a new tab
									</span>
								</a>
							</Tooltip>
						) : null}
						{port.forwarded === undefined ? null : (
							// Only while forwarded, and quieter than Open. Without it a tunnel
							// lives until the workspace dies, and "an explicit act with a visible
							// lifetime" -- the argument for publishing it at all -- stops being
							// true.
							<IconButton
								disabled={busy}
								icon={Square}
								label={`Stop forwarding ${port.port}`}
								size={14}
								onClick={() => stop.mutate(port.port)}
								variant="danger"
							/>
						)}
					</li>
				))}
			</ul>

			{note === "" ? null : <p className="detail-note">{note}</p>}
		</div>
	);
}

// openAt is where a row is reached: the container directly, or this controller if it was forwarded.
function openAt(
	data: { host: string; ip: string },
	port: { forwarded?: number; port: number },
): string {
	return port.forwarded === undefined
		? portUrl(data.ip, port.port)
		: portUrl(data.host, port.forwarded);
}
