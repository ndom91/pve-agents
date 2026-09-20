import { type ReactNode, useEffect, useState } from "react";

import { useRailWidth } from "../lib/use-rail-width";
// Type-only in this module's own imports, so nothing server-side follows it into the bundle. Taken
// from there rather than rebuilt here because a second copy of the branch prefix is a second thing
// that has to stay true, and the one the pushes actually use is that one.
import { workspaceBranch } from "../services/workspace-changes";
import { CopyButton } from "./copy-button";
import { RailResizer } from "./rail-resizer";

// RailWorkspace is the placement detail the rail reads. Structural rather than the full record, so
// this does not have to move every time the workspace type grows a field it does not show.
type RailWorkspace = {
	activityObservedAt?: string;
	createdAt?: string;
	currentStep?: string;
	desiredState?: string;
	hostname?: string;
	id?: string;
	ip?: string;
	lastActivityAt?: string;
	node?: string;
	provisionPhase?: string;
	readyAt?: string;
	ref?: string;
	repository?: string;
	taskUPID?: string;
	updatedAt?: string;
	vmid?: number;
};

// RailTab is what the rail is showing.
//
// A shape rather than a string. It once had a member carrying a file path, which is why: encoding a
// file as a reserved-prefixed string would have worked until a repository held a file called
// "diff". Files now unfold inside the diff tab and no member carries anything, but the shape is
// kept because widening it later is a type change rather than a parsing rule.
export type RailTab =
	| { kind: "details" }
	| { kind: "diff" }
	| { kind: "terminal" }
	| { kind: "timeline" };

// WorkspaceRail shows where a workspace lives, and what its agent has changed.
//
// Tabs rather than panels stacked, because they are read at different times and for different
// reasons. Placement is reference material you reach for when something has gone wrong. The list of
// changes is the actual output of the workspace.
//
// The tabs appear only once there is something to show beyond placement. A workspace still
// provisioning has no changes to list, and an empty tab would invite a click that answers nothing.
export function WorkspaceRail({
	actions,
	changes,
	onTab,
	tab = { kind: "details" },
	terminal,
	timeline,
	workspace,
}: {
	actions?: ReactNode;
	changes?: ReactNode;
	onTab?: (tab: RailTab) => void;
	tab?: RailTab;
	terminal?: ReactNode;
	timeline?: ReactNode;
	workspace: RailWorkspace;
}): ReactNode {
	const { setWidth, width } = useRailWidth();

	// Which panels have ever been opened. A panel stays mounted once it has been, and is hidden
	// rather than unmounted when another tab is chosen.
	//
	// This exists for the terminal. Unmounting it closes its socket, which kills the shell, so
	// glancing at the timeline mid-command and coming back landed you in a fresh session with your
	// work gone. Nothing else here minds either way; the terminal is why the rule exists.
	//
	// Still mounted lazily: a panel nobody opens is never built, which is what keeps the terminal's
	// WASM off a page that only wanted the placement facts.
	const [opened, setOpened] = useState<string[]>([]);

	useEffect(() => {
		setOpened((seen) => (seen.includes(tab.kind) ? seen : [...seen, tab.kind]));
	}, [tab.kind]);

	// The rail sets its own width rather than the grid setting it, so the handle does not have to
	// reach across routes to the layout that owns the columns. The grid's last column is `auto`.
	const sized = { width: `${width}px` };

	// Tabs appear once there is anything beyond placement to show. The timeline alone is enough:
	// a workspace that failed before it ever had a diff still has a history worth reading, and
	// that is exactly when somebody goes looking for one.
	const tabbed = changes ?? timeline ?? terminal;

	if (tabbed !== undefined && tab.kind !== "details") {
		return (
			<aside className="dashboard-rail" style={sized}>
				<RailResizer onResize={setWidth} width={width} />
				<Tabs
					changes={changes}
					onTab={onTab}
					tab={tab}
					terminal={terminal}
					timeline={timeline}
				/>
				<div className="rail-body">
					<Panel open={tab.kind === "diff"} seen={opened.includes("diff")}>
						{changes}
					</Panel>
					<Panel
						open={tab.kind === "timeline"}
						seen={opened.includes("timeline")}
					>
						{timeline}
					</Panel>
					<Panel
						open={tab.kind === "terminal"}
						seen={opened.includes("terminal")}
					>
						{terminal}
					</Panel>
				</div>
				{/* Only where they make sense. They act on the whole change list rather than on
				    one file, which is why they sit outside the tabs — but under a timeline or a
				    shell they are a control with no visible subject, and they take height the
				    terminal wants. */}
				{tab.kind === "diff" ? actions : null}
			</aside>
		);
	}

	return (
		<aside className="dashboard-rail" style={sized}>
			<RailResizer onResize={setWidth} width={width} />
			{tabbed === undefined ? (
				<p className="sidebar-label">Placement</p>
			) : (
				<Tabs
					changes={changes}
					onTab={onTab}
					tab={tab}
					terminal={terminal}
					timeline={timeline}
				/>
			)}
			<div className="rail-facts">
				<Group title="Source">
					<Fact label="Repository" value={workspace.repository} wide />
					<Fact label="Ref" value={workspace.ref} />
					<Fact
						label="Branch"
						value={
							workspace.hostname === undefined
								? undefined
								: workspaceBranch(workspace.hostname)
						}
						wide
					/>
				</Group>

				<Group title="Placement">
					<Fact label="Node" value={workspace.node} />
					<Fact label="VMID" value={workspace.vmid?.toString()} />
					<Fact label="Address" value={workspace.ip} />
					{/* The line somebody was assembling by hand out of the two rows above it every
					    time they wanted a shell outside the browser. */}
					<Fact
						copy
						label="SSH"
						value={
							workspace.ip === undefined
								? undefined
								: `ssh agent@${workspace.ip}`
						}
						wide
					/>
				</Group>

				<Group title="Progress">
					<Fact label="Phase" value={workspace.provisionPhase} />
					<Fact label="Step" value={workspace.currentStep} />
					<Fact label="Created" value={stamp(workspace.createdAt)} />
					<Fact label="Ready" value={stamp(workspace.readyAt)} />
					<Fact
						label="Took"
						value={took(workspace.createdAt, workspace.readyAt)}
					/>
					<Fact label="Last active" value={stamp(workspace.lastActivityAt)} />
					<Fact label="Checked" value={stamp(workspace.activityObservedAt)} />
					<Fact label="Updated" value={stamp(workspace.updatedAt)} />
				</Group>

				<Group title="Identity">
					<Fact copy label="Workspace" value={workspace.id} wide />
					<Fact label="Wanted" value={workspace.desiredState} />
					<Fact copy label="Task" value={workspace.taskUPID} wide />
				</Group>
			</div>
		</aside>
	);
}

// Panel keeps a tab's content alive once it has been opened, and out of the way when it has not.
//
// `hidden` rather than unmounting, because unmounting the terminal closes its socket and kills the
// shell behind it.
function Panel({
	children,
	open,
	seen,
}: {
	children?: ReactNode;
	open: boolean;
	seen: boolean;
}) {
	if (!seen || children === undefined) {
		return null;
	}

	return (
		<div className="rail-panel" hidden={!open}>
			{children}
		</div>
	);
}

// Tabs switches the rail between placement, the change list, the timeline and the shell.
function Tabs({
	changes,
	onTab,
	tab,
	terminal,
	timeline,
}: {
	changes?: ReactNode;
	onTab?: (tab: RailTab) => void;
	tab: RailTab;
	terminal?: ReactNode;
	timeline?: ReactNode;
}) {
	// Diff only for a workspace that has one. A destroyed container cannot be inspected, and a tab
	// that answers nothing is worse than an absent one.
	const fixed: { label: string; value: RailTab }[] = [
		{ label: "Details", value: { kind: "details" } },
		...(changes === undefined
			? []
			: [{ label: "Diff", value: { kind: "diff" } as RailTab }]),
		...(timeline === undefined
			? []
			: [{ label: "Timeline", value: { kind: "timeline" } as RailTab }]),
		...(terminal === undefined
			? []
			: [{ label: "Terminal", value: { kind: "terminal" } as RailTab }]),
	];

	return (
		// Scrolls sideways rather than wrapping, so the rail's height cannot change underneath the
		// panel below it on a narrow rail.
		<div className="rail-tabs" role="tablist">
			{fixed.map(({ label, value }) => (
				<button
					aria-selected={tab.kind === value.kind}
					className="rail-tab"
					key={label}
					onClick={() => onTab?.(value)}
					role="tab"
					type="button"
				>
					{label}
				</button>
			))}
		</div>
	);
}

// Fact renders one label and value, and nothing at all when there is no value yet.
//
// A workspace acquires these as it provisions, so a missing one means "not there yet" rather than
// "empty", and an empty row would read as a problem.
function Fact({
	copy = false,
	label,
	value,
	wide = false,
}: {
	copy?: boolean;
	label: string;
	value?: string;
	wide?: boolean;
}) {
	if (value === undefined || value === "") {
		return null;
	}

	return (
		<div className={wide ? "rail-fact rail-fact-wide" : "rail-fact"}>
			<dt>{label}</dt>
			<dd>
				<span>{value}</span>
				{copy ? (
					<CopyButton label={`Copy ${label.toLowerCase()}`} text={value} />
				) : null}
			</dd>
		</div>
	);
}

// Group is a heading and the facts under it.
//
// A group whose facts are all absent is hidden in CSS rather than here. Every Fact is an element
// either way — it decides to render nothing only once React asks it to — so counting children here
// would count the ones that are about to disappear. `.rail-group:not(:has(.rail-fact))` asks the
// question after the fact, which is the only point at which the answer is known.
function Group({
	children,
	title,
}: {
	children: ReactNode;
	title: string;
}): ReactNode {
	return (
		<section className="rail-group">
			<h3 className="rail-group-title">{title}</h3>
			<dl>{children}</dl>
		</section>
	);
}

// stamp trims an ISO timestamp to the second. The zone is UTC for every row and the milliseconds
// are noise in a column somebody reads rather than sorts.
function stamp(value?: string): string | undefined {
	return value?.slice(0, 19).replace("T", " ");
}

// took is how long provisioning ran, for the workspaces that have a ready_at.
//
// Undefined rather than "0s" when it does not: ready_at was never written before it was plumbed
// in, and every workspace older than that would otherwise claim to have been built instantly.
function took(createdAt?: string, readyAt?: string): string | undefined {
	if (createdAt === undefined || readyAt === undefined) {
		return undefined;
	}

	const ms = Date.parse(readyAt) - Date.parse(createdAt);
	if (!Number.isFinite(ms) || ms < 0) {
		return undefined;
	}

	const seconds = Math.round(ms / 1000);
	if (seconds < 60) {
		return `${seconds}s`;
	}
	return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
