import { useQuery } from "@tanstack/react-query";
import { ExternalLink, RotateCw } from "lucide-react";
import type { ReactNode } from "react";

import { portUrl, shortCwd } from "../domain/port";
import { AGENT_CWD } from "../domain/workspace-layout";
import { portsQuery } from "../lib/queries";
import { IconButton } from "./icon-button";
import { PanelNote, PanelSpinner } from "./panel-state";
import { Tooltip } from "./tooltip";

// PortsTab is what is listening inside the workspace, and how to open it.
//
// Modelled on the editor panel of the same name: the point is to answer "the dev server is up, now
// what is its address" without anybody opening a shell to run `ss` themselves.
export function PortsTab({ workspaceId }: { workspaceId: string }): ReactNode {
	const { data, isFetching, refetch } = useQuery(portsQuery(workspaceId));

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
					onClick={() => void refetch()}
					variant="tertiary"
				/>
			</div>

			<ul className="ports-list">
				{data.ports.map((port) => (
					<li className="ports-row" key={port.port}>
						<span className="ports-port">{port.port}</span>
						<span className="ports-process">{port.process}</span>
						{/* The directory the server was started in, which is how somebody tells two
						    Vite servers apart. Absent when /proc could not be read, and then the
						    column is simply empty rather than filled with a guess. */}
						<span className="ports-cwd">
							{port.cwd === undefined ? "" : shortCwd(port.cwd, AGENT_CWD)}
						</span>
						{port.reach === "direct" ? (
							// A real anchor wearing the icon button's clothes, rather than a button
							// that calls window.open. It looks identical and keeps everything a
							// link gives for free: cmd-click, middle-click, and "copy link
							// address" for pasting somewhere else.
							<Tooltip label={`Open ${portUrl(data.ip, port.port)}`}>
								<a
									className="icon-button is-tertiary"
									href={portUrl(data.ip, port.port)}
									rel="noreferrer"
									target="_blank"
								>
									<ExternalLink aria-hidden size={16} strokeWidth={1.75} />
									<span className="visually-hidden">
										Open port {port.port} in a new tab
									</span>
								</a>
							</Tooltip>
						) : (
							// No forward yet, so nothing to open. The word rather than a disabled
							// button: a greyed control invites a click and explains nothing, and
							// the reason this row differs is worth one word.
							<span className="ports-local">loopback</span>
						)}
					</li>
				))}
			</ul>
		</div>
	);
}
