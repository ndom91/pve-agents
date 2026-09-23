import { ExternalLink } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import {
	branchPage,
	parseRepository,
	repositoryPage,
} from "../domain/repository";
import type { ProvisionPhase } from "../domain/workspace";
import { isProvisioning } from "../domain/workspace-lifecycle";
import { formatStamp, provisionTook, UTC } from "../lib/clock";
import { useMounted } from "../lib/use-mounted";
import { useRailWidth } from "../lib/use-rail-width";
// Type-only in this module's own imports, so nothing server-side follows it into the bundle. Taken
// from there rather than rebuilt here because a second copy of the branch prefix is a second thing
// that has to stay true, and the one the pushes actually use is that one.
import { workspaceBranch } from "../services/workspace-changes";
import { CopyButton } from "./copy-button";
import { IconOutLink } from "./icon-button";
import { LifecycleStrip } from "./lifecycle-strip";
import { RailResizer } from "./rail-resizer";
import { SectionHead } from "./section-head";
import { StatusDot } from "./status-dot";
import { type Tab, TabStrip } from "./tab-strip";
import { Uptime } from "./uptime";

// RailWorkspace is the placement detail the rail reads. Structural rather than the full record, so
// this does not have to move every time the workspace type grows a field it does not show.
type RailWorkspace = {
	activity?: string;
	activityObservedAt?: string;
	createdAt?: string;
	currentStep?: string;
	desiredState?: string;
	hostname?: string;
	id?: string;
	ip?: string;
	lastActivityAt?: string;
	node?: string;
	provisionPhase?: ProvisionPhase;
	readyAt?: string;
	ref?: string;
	repository?: string;
	status?: string;
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
	// Timestamps below are the reader's zone once this is true, and UTC before it.
	const mounted = useMounted();

	const branch =
		workspace.hostname === undefined
			? undefined
			: workspaceBranch(workspace.hostname);
	const status = workspace.status;
	const readyIn = provisionTook(workspace.createdAt, workspace.readyAt);
	// Links only for a repository that parses. A stored value that does not is a workspace that
	// failed before it cloned, and a link built from it would go somewhere that is not there.
	const source = sourceLinks(workspace.repository, branch);

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
			{/* A workspace with nothing but placement to show gets no tab strip -- a row of one tab
			    is a label pretending to be a control, and the panel gets the height back. */}
			{tabbed === undefined ? null : (
				<Tabs
					changes={changes}
					onTab={onTab}
					tab={tab}
					terminal={terminal}
					timeline={timeline}
				/>
			)}
			<div className="rail-facts">
				{/* What the container is doing, before any of the reference material. It answers the
				    question somebody opens this tab with; the sections below answer the ones they
				    have after that. */}
				<div className="rail-state">
					{/* Silent: the word is printed beside it. */}
					<StatusDot
						activity={workspace.activity}
						silent
						status={status ?? "unknown"}
					/>
					<span className="rail-state-word">{status ?? "unknown"}</span>
					{status === "ready" && workspace.activity !== undefined ? (
						<span className="rail-state-sub">
							&middot; {workspace.activity}
						</span>
					) : null}
					<span className="spacer" />
					<span className="rail-state-up">
						<Uptime workspace={workspace} />
					</span>
				</div>

				{/* A link per row rather than one on the header. The header's link could only ever
				    mean the repository, which left the branch -- the thing you actually go and
				    look at -- with no way out at all, and put the one affordance furthest from
				    either value it might belong to. Each now sits after the value it opens and
				    appears on hover, like the copy buttons elsewhere in this panel. */}
				<Group title="Source">
					<Fact
						href={source?.repository}
						label="Repository"
						linkLabel="Open repository on GitHub"
						value={workspace.repository}
					/>
					<Fact label="Ref" value={workspace.ref} />
					<Fact
						href={source?.branch}
						label="Branch"
						linkLabel="Open branch on GitHub"
						value={branch}
					/>
				</Group>

				{/* Node, vmid and address are in the meta band as well. That is deliberate and it is
				    what the design draws: the band is the glance you get without opening anything,
				    and this tab is the full record you come to when the glance was not enough. */}
				<Group title="Placement">
					<div className="rail-grid is-3up">
						<Stack label="Node" value={workspace.node} />
						<Stack label="VMID" value={workspace.vmid?.toString()} />
						<Stack label="Address" value={workspace.ip} />
					</div>
				</Group>

				<Group
					title="Progress"
					trailing={
						readyIn === undefined ? undefined : (
							<span className="rail-took">ready in {readyIn}</span>
						)
					}
				>
					{/* Only while there is a climb to draw. The strip was unconditional, so the
					    details tab of a destroyed workspace showed six empty segments. */}
					{!isProvisioning(status) ? null : (
						<LifecycleStrip phase={workspace.provisionPhase} status={status} />
					)}
					<div className="rail-grid is-2up">
						<Stack label="Phase" value={workspace.provisionPhase} />
						<Stack label="Step" value={workspace.currentStep} />
						<Stack
							label="Created"
							value={stamp(workspace.createdAt, mounted)}
						/>
						<Stack label="Ready" value={stamp(workspace.readyAt, mounted)} />
						<Stack
							label="Last active"
							value={stamp(workspace.lastActivityAt, mounted)}
						/>
						<Stack
							label="Checked"
							value={stamp(workspace.activityObservedAt, mounted)}
						/>
						<Stack
							label="Updated"
							value={stamp(workspace.updatedAt, mounted)}
						/>
					</div>
				</Group>

				<Group title="Identity">
					{/* The container's name. It led the page until the agent started naming its own
					    work; it is still what the push branch is built from, so it belongs
					    somewhere readable rather than nowhere. */}
					<Fact label="Name" value={workspace.hostname} />
					<Fact copy label="Workspace" value={workspace.id} />
					<Fact label="Wanted" value={workspace.desiredState} />
					<Fact copy label="Task" value={workspace.taskUPID} />
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
	const fixed: Tab<RailTab>[] = [
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
		<TabStrip
			current={tab}
			onSelect={onTab}
			// Compared by kind rather than by identity, because the tab arrives as a fresh object
			// on every render and no two would ever be the same reference.
			sameTab={(a, b) => a.kind === b.kind}
			tabs={fixed}
		/>
	);
}

// sourceLinks builds the two GitHub URLs, or nothing if the repository does not parse.
//
// Both or neither. They are built from the same parsed owner and name, so there is no state where
// one is reachable and the other is not.
function sourceLinks(
	repository?: string,
	branch?: string,
): { branch?: string; repository: string } | undefined {
	if (repository === undefined) {
		return undefined;
	}

	const parsed = parseRepository(repository);
	if (parsed.kind !== "parsed") {
		return undefined;
	}

	return {
		branch: branch === undefined ? undefined : branchPage(parsed, branch),
		repository: repositoryPage(parsed),
	};
}

// Fact is one inline label-and-value row: a fixed 88px key, then the value.
//
// Nothing at all when there is no value. A workspace acquires these as it provisions, so a missing
// one means "not there yet" rather than "empty", and an empty row reads as a problem.
function Fact({
	copy = false,
	href,
	label,
	linkLabel,
	value,
}: {
	copy?: boolean;
	// Somewhere to read this value that is not here. Only for the ones that name something on
	// GitHub; the rest are this controller's own facts and lead nowhere.
	href?: string;
	label: string;
	linkLabel?: string;
	value?: string;
}) {
	if (value === undefined || value === "") {
		return null;
	}

	return (
		<div className="rail-fact reveals">
			<dt>{label}</dt>
			<dd>
				<span className="rail-fact-value">{value}</span>
				{copy ? (
					<CopyButton label={`Copy ${label.toLowerCase()}`} text={value} />
				) : null}
				{href === undefined ? null : (
					<IconOutLink
						className="fact-open is-inline on-hover"
						href={href}
						icon={ExternalLink}
						label={linkLabel ?? `Open ${label.toLowerCase()} on GitHub`}
						size={12}
						variant="tertiary"
					/>
				)}
			</dd>
		</div>
	);
}

// Stack is the same pair with the label above the value, for a cell in a grid.
//
// Two shapes rather than one because the value decides: a repository URL wants the width of the
// panel and a vmid wants a third of it, and forcing either into the other's shape wastes a column
// or clips a string.
function Stack({ label, value }: { label: string; value?: string }) {
	if (value === undefined || value === "") {
		return null;
	}

	return (
		// dt/dd rather than two divs: these are the same term-and-description pairs as the inline
		// rows above them, turned ninety degrees, and a screen reader should hear them that way.
		<div className="rail-cell">
			<dt className="rail-cell-key">{label}</dt>
			<dd className="rail-cell-value">{value}</dd>
		</div>
	);
}

// Group is a section header and the facts under it.
//
// A group whose facts are all absent is hidden in CSS rather than here. Every Fact is an element
// either way -- it decides to render nothing only once React asks it to -- so counting children
// here would count the ones that are about to disappear.
function Group({
	children,
	title,
	trailing,
}: {
	children: ReactNode;
	title: string;
	// Anything on the far right of the header. There were two of these, `action` and `trailing`,
	// collapsed into one slot by `action ?? trailing` -- one caller used each, and the one that
	// wanted `action` now puts its links on the rows instead.
	trailing?: ReactNode;
}): ReactNode {
	return (
		<section className="rail-group">
			<SectionHead label={title} trailing={trailing} />
			<dl>{children}</dl>
		</section>
	);
}

// stamp renders one timestamp for a Fact, in the reader's own zone once the page has mounted.
//
// A string rather than the `Timestamp` component, because `Fact` takes a value it may decide not
// to render at all. Passing an element would mean an element that renders nothing, which is not
// the same as no row -- and no row is what an absent timestamp should produce.
//
// UTC until mounted, so the server render and the first client render agree. The swap happens in
// the same tick as the effect.
function stamp(value: string | undefined, local: boolean): string | undefined {
	return formatStamp(value, local ? undefined : UTC);
}
