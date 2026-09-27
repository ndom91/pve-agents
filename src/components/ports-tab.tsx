import { useMutation, useQuery } from "@tanstack/react-query";
import { ExternalLink, RotateCw, Share2, Square } from "lucide-react";
import { type ReactNode, useState } from "react";

import { portUrl, type Reach, shortCwd } from "../domain/port";
import { AGENT_CWD } from "../domain/workspace-layout";
import { portsQuery } from "../lib/queries";
import { forwardPort, stopPort } from "../server/agent.functions";
import { IconButton } from "./icon-button";
import { PanelNote, PanelSpinner } from "./panel-state";
import { Tooltip } from "./tooltip";

// PortsTab is what is listening inside the workspace, and how to open it.
//
// Modelled on VS Code's panel of the same name.
export function PortsTab({ workspaceId }: { workspaceId: string }): ReactNode {
	const { data, isFetching, refetch } = useQuery(portsQuery(workspaceId));
	const [note, setNote] = useState("");

	// Both re-read the list rather than patching it, because the listing and the forwards are one
	// answer from the server. Rebuilding half of it here can show Stop over a dead tunnel.
	const forward = useMutation({
		mutationFn: (port: number) =>
			forwardPort({ data: { id: workspaceId, port } }),
		onError: (error) => setNote(error.message),
		onSuccess: async (result) => {
			setNote(result.kind === "unavailable" ? result.reason : "");
			await refetch();
		},
	});
	const stop = useMutation({
		mutationFn: (port: number) => stopPort({ data: { id: workspaceId, port } }),
		onError: (error) => setNote(error.message),
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
		// Says what was excluded, or an empty tab beside a running sshd reads as broken.
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
				{data.ports.map((port) => {
					const url = openAt(data, port);

					return (
						<li className="ports-row" key={port.port}>
							<span className="ports-port">
								{port.port}
								{port.forwarded === undefined ? null : (
									<span className="ports-forwarded"> ({port.forwarded})</span>
								)}
							</span>
							<span className="ports-process">{port.process}</span>
							<span className="ports-cwd">
								{port.cwd === undefined ? "" : shortCwd(port.cwd, AGENT_CWD)}
							</span>
							<span className="ports-actions">
								{url === undefined ? (
									<IconButton
										disabled={busy}
										icon={Share2}
										label={`Forward ${port.port} to this controller`}
										size={14}
										onClick={() => forward.mutate(port.port)}
										variant="tertiary"
									/>
								) : (
									// A real anchor styled as an icon button, so cmd-click,
									// middle-click and "copy link address" all work.
									<Tooltip label={`Open ${url}`}>
										<a
											className="icon-button is-tertiary"
											href={url}
											rel="noreferrer"
											target="_blank"
										>
											<ExternalLink aria-hidden size={14} strokeWidth={1.75} />
											<span className="visually-hidden">
												Open port {port.port} in a new tab
											</span>
										</a>
									</Tooltip>
								)}
								{port.forwarded === undefined ? null : (
									<IconButton
										disabled={busy}
										icon={Square}
										label={`Stop forwarding ${port.port}`}
										size={14}
										onClick={() => stop.mutate(port.port)}
										variant="danger"
									/>
								)}
							</span>
						</li>
					);
				})}
			</ul>

			{note === "" ? null : <p className="detail-note">{note}</p>}
		</div>
	);
}

// openAt is where a row is reached: the container directly, this controller if it was forwarded,
// or nowhere yet for a loopback port.
function openAt(
	data: { host: string; ip: string },
	port: { forwarded?: number; port: number; reach: Reach },
): string | undefined {
	if (port.forwarded !== undefined) {
		return portUrl(data.host, port.forwarded);
	}

	return port.reach === "direct" ? portUrl(data.ip, port.port) : undefined;
}
