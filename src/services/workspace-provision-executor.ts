import type Database from "better-sqlite3";

import type { ControllerConfig } from "../config/controller-config";
import {
	advanceWorkspaceProvision,
	advanceWorkspaceStatus,
	completeWorkspaceOperation,
	confirmWorkspaceClone,
	failWorkspaceProvision,
	noteWorkspaceIssue,
	type OperationLease,
	prepareWorkspaceProvision,
	recordWorkspaceTask,
	releaseWorkspaceCandidateVMID,
	releaseWorkspaceOperation,
	reservedVMIDs,
	type WorkspaceProvision,
	workspaceProvision,
	workspaceRequest,
} from "../db/workspace-repository";
import { parseRepository } from "../domain/repository";
import { claudeAwaitingInput, prepareClaudeWorkspace } from "./claude-agent";
import { type GitHubAppCredentials, installationToken } from "./github-app";
import {
	createHerdrWorkspace,
	type HerdrTarget,
	herdrAgentName,
	herdrAgentStatus,
	herdrServerState,
	promptHerdrAgent,
	readHerdrAgent,
	startHerdrAgent,
	startHerdrServer,
} from "./herdr";
import { containerAddress } from "./proxmox-address";
import {
	allocateProxmoxVMID,
	cloneWorkspace,
	nextProxmoxVMID,
} from "./proxmox-clone";
import {
	containerConfig,
	containerDescription,
	startContainer,
} from "./proxmox-container";
import type { Fetcher } from "./proxmox-http";
import { ownershipMatches, parseOwnershipMarker } from "./proxmox-ownership";
import { poolContainsVMID } from "./proxmox-pool";
import { runningCloneTask } from "./proxmox-task";
import type { SshRunner, SshTarget } from "./ssh";
import { checkoutRepository } from "./workspace-checkout";
import {
	awaitTask,
	POLL_INTERVAL_MS,
	proxmoxCredentials,
	taskExpiry,
	type WorkspaceOperationRun,
	workspaceNode,
} from "./workspace-task";

// AGENT_CWD is where the agent runs inside the workspace.
//
// Created during bootstrap and filled by the checkout step, so the agent's first pane opens in a
// working copy rather than an empty directory.
const AGENT_CWD = "/workspace/repo";

// workspaceSsh builds the connection to a workspace, or nothing when no key is configured.
function workspaceSsh(
	config: ControllerConfig,
	workspace: WorkspaceProvision,
): SshTarget | undefined {
	return config.WORKSPACE_SSH_KEY_PATH === undefined
		? undefined
		: {
				address: workspace.ip as string,
				keyPath: config.WORKSPACE_SSH_KEY_PATH,
				user: config.WORKSPACE_SSH_USER,
			};
}

// summarise picks the line of a pane most likely to tell an operator what it is asking.
//
// Whole terminal snapshots are mostly banner art and blank rows, and the timeline shows one line.
function summarise(pane: string): string {
	const lines = pane
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => /[a-z]{4}/i.test(line));

	return lines.at(-1)?.slice(0, 160) ?? "no readable output";
}

// herdrTarget addresses the workspace's named Herdr server.
function herdrTarget(
	config: ControllerConfig,
	workspace: WorkspaceProvision,
): HerdrTarget | undefined {
	const ssh = workspaceSsh(config, workspace);

	return ssh === undefined
		? undefined
		: { session: config.WORKSPACE_HERDR_SESSION, ssh };
}

// executeWorkspaceProvision advances one provision operation by exactly one durable step.
//
// Every step is chosen from persisted state rather than in-memory progress, so a controller that
// crashes mid-task resumes from the same decision the next pass would have made anyway.
export async function executeWorkspaceProvision(
	db: Database.Database,
	config: ControllerConfig,
	lease: OperationLease,
	fetcher: Fetcher,
	now: Date,
	ssh: SshRunner,
): Promise<WorkspaceOperationRun> {
	const workspace = workspaceProvision(db, lease);
	if (workspace === undefined) {
		releaseWorkspaceOperation(db, lease, POLL_INTERVAL_MS, now);

		return { processed: 1, status: "stale_operation" };
	}

	// Dispatch on the recorded phase, not on which columns happen to be set: current_task_upid is
	// one column shared by every task, so a start task and a clone task are otherwise identical.
	switch (workspace.phase) {
		case "clone-submitted":
			return workspace.taskUPID === undefined
				? reconcileCandidate(db, config, lease, workspace, fetcher, now)
				: pollClone(db, config, lease, workspace, fetcher, now);
		case "clone-confirmed":
			return submitStart(db, config, lease, workspace, fetcher, now);
		case "start-submitted":
			return pollStart(db, lease, workspace, config, fetcher, now);
		case "booted":
			return discoverAddress(db, config, lease, workspace, fetcher, now);
		case "addressed":
			return checkReachable(db, config, lease, workspace, now, ssh);
		case "reachable":
			return bootstrapAgentHome(db, config, lease, workspace, now, ssh);
		case "bootstrapped":
			return checkoutWorkspaceRepository(
				db,
				config,
				lease,
				workspace,
				fetcher,
				now,
				ssh,
			);
		case "checked-out":
			return startHerdrSession(db, config, lease, workspace, now, ssh);
		case "session-started":
			return registerHerdrWorkspace(db, config, lease, workspace, now, ssh);
		case "herdr-registered":
			return startWorkspaceAgent(db, config, lease, workspace, now, ssh);
		case "agent-started":
			return briefWorkspaceAgent(db, config, lease, workspace, now, ssh);
		case "briefed":
			// Reached only by an operation that advanced and then lost its release, since the pass
			// that sets this phase also completes.
			completeWorkspaceOperation(db, lease, now);

			return { processed: 1, status: "workspace_ready" };
		default:
			// No phase yet. A VMID without one means a clone landed before phases existed, or a
			// candidate was persisted and the response lost.
			return workspace.vmid === undefined
				? submitClone(db, config, lease, workspace, fetcher, now)
				: reconcileCandidate(db, config, lease, workspace, fetcher, now);
	}
}

// checkReachable confirms the controller can actually log in.
//
// A booted container is not a usable one: sshd starts after boot, and the first clone from a new
// template is where a missing key or an unreachable network shows up. Proving it here means every
// later step can assume a working connection.
async function checkReachable(
	db: Database.Database,
	config: ControllerConfig,
	lease: OperationLease,
	workspace: WorkspaceProvision,
	now: Date,
	ssh: SshRunner,
): Promise<WorkspaceOperationRun> {
	const keyPath = config.WORKSPACE_SSH_KEY_PATH;
	if (keyPath === undefined) {
		failWorkspaceProvision(
			db,
			lease,
			"ssh_key_missing",
			"WORKSPACE_SSH_KEY_PATH is not configured",
			now,
		);

		return { processed: 1, status: "task_failed" };
	}

	const result = await ssh(
		{
			address: workspace.ip as string,
			keyPath,
			user: config.WORKSPACE_SSH_USER,
		},
		["true"],
	);

	if (result.kind === "refused") {
		releaseWorkspaceOperation(db, lease, POLL_INTERVAL_MS, now);

		return { processed: 1, status: "awaiting_ssh" };
	}
	if (result.kind === "rejected") {
		// A rejected key or a changed host key will not fix itself, and retrying buries the
		// reason under an hour of identical attempts.
		failWorkspaceProvision(db, lease, "ssh_rejected", result.message, now);

		return { processed: 1, status: "task_failed" };
	}
	if (result.code !== 0) {
		releaseWorkspaceOperation(db, lease, POLL_INTERVAL_MS, now);

		return { processed: 1, status: "awaiting_ssh" };
	}

	advanceWorkspaceProvision(
		db,
		lease,
		{
			event: {
				message: `controller can reach ${workspace.ip} as ${config.WORKSPACE_SSH_USER}`,
				type: "workspace.reachable",
			},
			phase: "reachable",
			step: "reachable over ssh",
		},
		now,
	);
	releaseWorkspaceOperation(db, lease, 0, now);

	return { processed: 1, status: "ssh_ready" };
}

// bootstrapAgentHome prepares the workspace for an agent that nobody is watching.
//
// Claude Code's first run is an interactive wizard. Seeding the flag that skips it is what makes
// an unattended start possible at all.
async function bootstrapAgentHome(
	db: Database.Database,
	config: ControllerConfig,
	lease: OperationLease,
	workspace: WorkspaceProvision,
	now: Date,
	ssh: SshRunner,
): Promise<WorkspaceOperationRun> {
	const target = workspaceSsh(config, workspace);
	if (target === undefined) {
		failWorkspaceProvision(
			db,
			lease,
			"ssh_key_missing",
			"WORKSPACE_SSH_KEY_PATH is not configured",
			now,
		);

		return { processed: 1, status: "task_failed" };
	}

	const token = config.WORKSPACE_CLAUDE_OAUTH_TOKEN;
	if (token === undefined) {
		failWorkspaceProvision(
			db,
			lease,
			"agent_token_missing",
			"WORKSPACE_CLAUDE_OAUTH_TOKEN is not configured",
			now,
		);

		return { processed: 1, status: "task_failed" };
	}

	const prepared = await prepareClaudeWorkspace(
		target,
		{ cwd: AGENT_CWD, token },
		ssh,
	);
	if (prepared.kind === "failed") {
		noteWorkspaceIssue(db, lease, prepared.message, now);
		releaseWorkspaceOperation(db, lease, POLL_INTERVAL_MS, now);

		return { processed: 1, status: "request_failed" };
	}

	advanceWorkspaceProvision(
		db,
		lease,
		{
			event: {
				message: `prepared ${AGENT_CWD} for an unattended agent`,
				type: "workspace.bootstrapped",
			},
			phase: "bootstrapped",
			status: "bootstrapping",
			step: "agent home prepared",
		},
		now,
	);
	releaseWorkspaceOperation(db, lease, 0, now);

	return { processed: 1, status: "bootstrapped" };
}

// checkoutWorkspaceRepository puts the requested repository into the workspace.
//
// Before the Herdr session rather than after, so the agent's pane opens in a populated repository
// instead of racing the clone.
async function checkoutWorkspaceRepository(
	db: Database.Database,
	config: ControllerConfig,
	lease: OperationLease,
	workspace: WorkspaceProvision,
	fetcher: Fetcher,
	now: Date,
	ssh: SshRunner,
): Promise<WorkspaceOperationRun> {
	const target = workspaceSsh(config, workspace);
	if (target === undefined) {
		failWorkspaceProvision(
			db,
			lease,
			"ssh_key_missing",
			"WORKSPACE_SSH_KEY_PATH is not configured",
			now,
		);

		return { processed: 1, status: "task_failed" };
	}

	const credentials = githubAppCredentials(config);
	if (credentials === undefined) {
		failWorkspaceProvision(
			db,
			lease,
			"github_app_missing",
			"GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID and GITHUB_APP_PRIVATE_KEY_PATH are required to check out a repository",
			now,
		);

		return { processed: 1, status: "task_failed" };
	}

	const request = workspaceRequest(db, workspace.id);
	if (request === undefined) {
		return { processed: 1, status: "stale_operation" };
	}

	const repository = parseRepository(request.repository);
	if (repository.kind === "invalid") {
		// The request named something this controller will not clone. No retry will change that,
		// and the reason belongs in front of whoever asked for it.
		failWorkspaceProvision(
			db,
			lease,
			"repository_invalid",
			`${request.repository}: ${repository.message}`,
			now,
		);

		return { processed: 1, status: "task_failed" };
	}

	const minted = await installationToken(credentials, repository, fetcher);
	if (minted.kind === "failed") {
		noteWorkspaceIssue(db, lease, minted.message, now);
		releaseWorkspaceOperation(db, lease, POLL_INTERVAL_MS, now);

		return { processed: 1, status: "request_failed" };
	}

	const cloned = await checkoutRepository(
		target,
		{
			cwd: AGENT_CWD,
			ref: request.ref,
			repository,
			token: minted.token,
		},
		ssh,
	);
	if (cloned.kind === "failed") {
		noteWorkspaceIssue(db, lease, cloned.message, now);
		releaseWorkspaceOperation(db, lease, POLL_INTERVAL_MS, now);

		return { processed: 1, status: "request_failed" };
	}

	advanceWorkspaceProvision(
		db,
		lease,
		{
			credentialAt: now.toISOString(),
			event: {
				message: `checked out ${repository.owner}/${repository.name} at ${request.ref}`,
				type: "workspace.checked_out",
			},
			phase: "checked-out",
			step: `checked out ${request.ref}`,
		},
		now,
	);
	releaseWorkspaceOperation(db, lease, 0, now);

	return { processed: 1, status: "checked_out" };
}

// githubAppCredentials assembles the App settings, or nothing when the App is not configured.
function githubAppCredentials(
	config: ControllerConfig,
): GitHubAppCredentials | undefined {
	const appId = config.GITHUB_APP_ID;
	const installationId = config.GITHUB_APP_INSTALLATION_ID;
	const privateKeyPath = config.GITHUB_APP_PRIVATE_KEY_PATH;

	return appId === undefined ||
		installationId === undefined ||
		privateKeyPath === undefined
		? undefined
		: { appId, installationId, privateKeyPath };
}

// startHerdrSession brings up the named Herdr server the workspace's panes will live in.
//
// Starting and confirming are separate calls because launching is detached: the command returns
// before the socket is listening, so only a later status check proves anything.
async function startHerdrSession(
	db: Database.Database,
	config: ControllerConfig,
	lease: OperationLease,
	workspace: WorkspaceProvision,
	now: Date,
	ssh: SshRunner,
): Promise<WorkspaceOperationRun> {
	const target = herdrTarget(config, workspace);
	if (target === undefined) {
		failWorkspaceProvision(
			db,
			lease,
			"ssh_key_missing",
			"WORKSPACE_SSH_KEY_PATH is not configured",
			now,
		);

		return { processed: 1, status: "task_failed" };
	}

	const state = await herdrServerState(target, ssh);
	if (state.kind === "failed") {
		noteWorkspaceIssue(db, lease, state.message, now);
		releaseWorkspaceOperation(db, lease, POLL_INTERVAL_MS, now);

		return { processed: 1, status: "awaiting_session" };
	}
	if (state.kind === "stopped") {
		const started = await startHerdrServer(target, ssh);
		if (started.kind === "failed") {
			noteWorkspaceIssue(db, lease, started.message, now);
		}
		releaseWorkspaceOperation(db, lease, POLL_INTERVAL_MS, now);

		return { processed: 1, status: "awaiting_session" };
	}

	advanceWorkspaceProvision(
		db,
		lease,
		{
			event: {
				message: `herdr session ${config.WORKSPACE_HERDR_SESSION} is running`,
				type: "workspace.session_started",
			},
			phase: "session-started",
			step: "herdr session running",
		},
		now,
	);
	releaseWorkspaceOperation(db, lease, 0, now);

	return { processed: 1, status: "session_started" };
}

// registerHerdrWorkspace creates the Herdr workspace the agent will run in.
//
// Carries no credentials: the pane's shell picks those up from the file bootstrap wrote, so
// nothing secret passes through a Herdr argument.
async function registerHerdrWorkspace(
	db: Database.Database,
	config: ControllerConfig,
	lease: OperationLease,
	workspace: WorkspaceProvision,
	now: Date,
	ssh: SshRunner,
): Promise<WorkspaceOperationRun> {
	const target = herdrTarget(config, workspace);
	if (target === undefined) {
		failWorkspaceProvision(
			db,
			lease,
			"ssh_key_missing",
			"WORKSPACE_SSH_KEY_PATH is not configured",
			now,
		);

		return { processed: 1, status: "task_failed" };
	}

	const created = await createHerdrWorkspace(
		target,
		{ cwd: AGENT_CWD, label: workspace.hostname },
		ssh,
	);
	if (created.kind === "rejected") {
		failWorkspaceProvision(
			db,
			lease,
			"herdr_workspace_rejected",
			created.message,
			now,
		);

		return { processed: 1, status: "task_failed" };
	}
	if (created.kind === "failed") {
		noteWorkspaceIssue(db, lease, created.message, now);
		releaseWorkspaceOperation(db, lease, POLL_INTERVAL_MS, now);

		return { processed: 1, status: "request_failed" };
	}

	advanceWorkspaceProvision(
		db,
		lease,
		{
			event: {
				message: `herdr workspace ${created.workspaceId} rooted at ${created.cwd}`,
				type: "workspace.herdr_registered",
			},
			herdrPaneId: created.paneId,
			herdrWorkspaceId: created.workspaceId,
			phase: "herdr-registered",
			status: "registering",
			step: `herdr workspace ${created.workspaceId}`,
		},
		now,
	);
	releaseWorkspaceOperation(db, lease, 0, now);

	return { processed: 1, status: "herdr_registered" };
}

// startWorkspaceAgent starts the coding agent and proves it is actually usable.
//
// The pane is read afterwards because Herdr cannot tell a working agent from one sitting in a
// first-run wizard: both report "idle" and both exit 0. Only the screen distinguishes them.
async function startWorkspaceAgent(
	db: Database.Database,
	config: ControllerConfig,
	lease: OperationLease,
	workspace: WorkspaceProvision,
	now: Date,
	ssh: SshRunner,
): Promise<WorkspaceOperationRun> {
	const target = herdrTarget(config, workspace);
	if (target === undefined) {
		failWorkspaceProvision(
			db,
			lease,
			"ssh_key_missing",
			"WORKSPACE_SSH_KEY_PATH is not configured",
			now,
		);

		return { processed: 1, status: "task_failed" };
	}

	const name = herdrAgentName(workspace.hostname);
	const paneId = workspace.herdrPaneId;
	if (name === undefined || paneId === undefined) {
		failWorkspaceProvision(
			db,
			lease,
			"agent_target_missing",
			name === undefined
				? `${workspace.hostname} is not a usable herdr agent name`
				: "herdr pane was not recorded",
			now,
		);

		return { processed: 1, status: "task_failed" };
	}

	const started = await startHerdrAgent(
		target,
		{ agentKind: config.WORKSPACE_AGENT_KIND, name, paneId },
		ssh,
	);
	if (started.kind === "rejected") {
		failWorkspaceProvision(
			db,
			lease,
			"agent_start_rejected",
			started.message,
			now,
		);

		return { processed: 1, status: "task_failed" };
	}
	if (started.kind === "failed") {
		noteWorkspaceIssue(db, lease, started.message, now);
		releaseWorkspaceOperation(db, lease, POLL_INTERVAL_MS, now);

		return { processed: 1, status: "awaiting_agent" };
	}

	const state = await herdrAgentStatus(target, name, ssh);
	if (state.kind === "failed") {
		noteWorkspaceIssue(db, lease, state.message, now);
		releaseWorkspaceOperation(db, lease, POLL_INTERVAL_MS, now);

		return { processed: 1, status: "awaiting_agent" };
	}

	const pane = await readHerdrAgent(target, name, ssh);
	if (pane.kind === "failed") {
		noteWorkspaceIssue(db, lease, pane.message, now);
		releaseWorkspaceOperation(db, lease, POLL_INTERVAL_MS, now);

		return { processed: 1, status: "awaiting_agent" };
	}

	// Two signals, because each covers the other's blind spot. "blocked" catches any dialog,
	// including ones this controller has never seen. The pane text catches the first-run gates
	// Herdr reports as a perfectly ordinary idle agent.
	if (state.status === "blocked" || claudeAwaitingInput(pane.text)) {
		// No amount of retrying dismisses a dialog, and handing the workspace over would let its
		// first prompt be typed into a menu.
		failWorkspaceProvision(
			db,
			lease,
			"agent_awaiting_input",
			`${config.WORKSPACE_AGENT_KIND} is waiting for input: ${summarise(pane.text)}`,
			now,
		);

		return { processed: 1, status: "task_failed" };
	}
	if (started.kind === "not-ready" || state.status === "unknown") {
		releaseWorkspaceOperation(db, lease, POLL_INTERVAL_MS, now);

		return { processed: 1, status: "awaiting_agent" };
	}

	advanceWorkspaceProvision(
		db,
		lease,
		{
			event: {
				message: `${config.WORKSPACE_AGENT_KIND} running as ${name} in ${paneId}`,
				type: "workspace.agent_started",
			},
			phase: "agent-started",
			step: "agent running",
		},
		now,
	);
	releaseWorkspaceOperation(db, lease, 0, now);

	return { processed: 1, status: "agent_started" };
}

// briefWorkspaceAgent tells the agent what the workspace was requested for.
//
// This is what makes "ready" mean working on it rather than merely built. The purpose is sent
// verbatim: wrapping it in invented context would hand the agent instructions the operator never
// wrote, and a terse prompt is better than a surprising one.
async function briefWorkspaceAgent(
	db: Database.Database,
	config: ControllerConfig,
	lease: OperationLease,
	workspace: WorkspaceProvision,
	now: Date,
	ssh: SshRunner,
): Promise<WorkspaceOperationRun> {
	const request = workspaceRequest(db, workspace.id);
	const purpose = request?.purpose?.trim();
	const target = herdrTarget(config, workspace);
	const name = herdrAgentName(workspace.hostname);

	// Nothing to say. A workspace requested without a purpose is ready and idle, waiting for
	// someone to tell it something from the UI.
	if (
		purpose === undefined ||
		purpose === "" ||
		target === undefined ||
		name === undefined
	) {
		advanceWorkspaceProvision(
			db,
			lease,
			{
				event: {
					message: "workspace ready, awaiting instructions",
					type: "workspace.ready",
				},
				phase: "briefed",
				status: "ready",
				step: "ready",
			},
			now,
		);
		completeWorkspaceOperation(db, lease, now);

		return { processed: 1, status: "workspace_ready" };
	}

	const prompted = await promptHerdrAgent(target, name, purpose, ssh);
	if (prompted.kind === "failed") {
		noteWorkspaceIssue(db, lease, prompted.message, now);
		releaseWorkspaceOperation(db, lease, POLL_INTERVAL_MS, now);

		return { processed: 1, status: "awaiting_agent" };
	}
	// Blocked before it was even briefed. Retrying cannot clear a dialog, and the workspace is
	// usable: an operator answers it and prompts by hand. Better ready and waiting than failed.
	if (prompted.kind === "blocked") {
		noteWorkspaceIssue(
			db,
			lease,
			"agent was waiting for input before it could be briefed",
			now,
		);
	}

	advanceWorkspaceProvision(
		db,
		lease,
		{
			event: {
				message:
					prompted.kind === "blocked"
						? "workspace ready, agent waiting for input"
						: `briefed: ${summarise(purpose)}`,
				type: "workspace.ready",
			},
			phase: "briefed",
			status: "ready",
			step: "ready",
		},
		now,
	);
	completeWorkspaceOperation(db, lease, now);

	return { processed: 1, status: "workspace_ready" };
}

// discoverAddress records where the workspace can be reached.
//
// DHCP does not answer the instant a container boots, so an address that is not there yet is
// pending rather than a failure. The operation deadline bounds how long that is tolerated.
async function discoverAddress(
	db: Database.Database,
	config: ControllerConfig,
	lease: OperationLease,
	workspace: WorkspaceProvision,
	fetcher: Fetcher,
	now: Date,
): Promise<WorkspaceOperationRun> {
	const api = workspaceNode(config, workspace);
	const found = await containerAddress(
		api,
		workspace.vmid as number,
		config.WORKSPACE_SUBNET,
		fetcher,
	);
	if (found.kind === "failed") {
		noteWorkspaceIssue(db, lease, found.message, now);
		releaseWorkspaceOperation(db, lease, POLL_INTERVAL_MS, now);

		return { processed: 1, status: "awaiting_address" };
	}
	if (found.kind === "pending") {
		releaseWorkspaceOperation(db, lease, POLL_INTERVAL_MS, now);

		return { processed: 1, status: "awaiting_address" };
	}

	advanceWorkspaceProvision(
		db,
		lease,
		{
			event: {
				message: `workspace reachable at ${found.address}`,
				type: "workspace.addressed",
			},
			ip: found.address,
			phase: "addressed",
			step: `address ${found.address}`,
		},
		now,
	);
	releaseWorkspaceOperation(db, lease, 0, now);

	return { processed: 1, status: "address_found" };
}

// submitStart boots the confirmed clone.
async function submitStart(
	db: Database.Database,
	config: ControllerConfig,
	lease: OperationLease,
	workspace: WorkspaceProvision,
	fetcher: Fetcher,
	now: Date,
): Promise<WorkspaceOperationRun> {
	const api = workspaceNode(config, workspace);
	const start = await startContainer(api, workspace.vmid as number, fetcher);
	if (start.kind === "failed") {
		noteWorkspaceIssue(db, lease, start.message, now);
		releaseWorkspaceOperation(db, lease, POLL_INTERVAL_MS, now);

		return { processed: 1, status: "request_failed" };
	}

	const recorded = recordWorkspaceTask(
		db,
		lease,
		{
			expiresAt: taskExpiry(now),
			kind: "provision",
			phase: "start-submitted",
			step: "start task accepted",
			upid: start.upid,
		},
		now,
	);
	if (recorded.kind !== "prepared") {
		return { processed: 1, status: "stale_operation" };
	}

	// Booting begins when the task is accepted, not when it finishes: the container is no longer
	// merely provisioned from here.
	advanceWorkspaceStatus(db, lease, "booting", now);
	releaseWorkspaceOperation(db, lease, POLL_INTERVAL_MS, now);

	return { processed: 1, status: "start_submitted" };
}

// pollStart resolves the boot task.
async function pollStart(
	db: Database.Database,
	lease: OperationLease,
	workspace: WorkspaceProvision,
	config: ControllerConfig,
	fetcher: Fetcher,
	now: Date,
): Promise<WorkspaceOperationRun> {
	const task = await awaitTask(
		config,
		workspace.taskUPID as string,
		workspace.taskExpiresAt,
		fetcher,
		now,
	);
	if (task.kind === "pending") {
		releaseWorkspaceOperation(db, lease, POLL_INTERVAL_MS, now);

		return { processed: 1, status: "awaiting_task" };
	}
	if (task.kind !== "succeeded") {
		failWorkspaceProvision(
			db,
			lease,
			task.kind === "failed" ? "start_task_failed" : "start_task_timeout",
			task.kind === "failed"
				? task.message
				: "proxmox start task did not finish before its deadline",
			now,
		);

		return { processed: 1, status: "task_failed" };
	}

	advanceWorkspaceProvision(
		db,
		lease,
		{
			event: {
				message: "proxmox confirmed the container booted",
				type: "workspace.booted",
			},
			phase: "booted",
			step: "container booted",
		},
		now,
	);
	releaseWorkspaceOperation(db, lease, 0, now);

	return { processed: 1, status: "container_booted" };
}

// pollClone resolves a submitted clone task against Proxmox.
async function pollClone(
	db: Database.Database,
	config: ControllerConfig,
	lease: OperationLease,
	workspace: WorkspaceProvision,
	fetcher: Fetcher,
	now: Date,
): Promise<WorkspaceOperationRun> {
	const task = await awaitTask(
		config,
		workspace.taskUPID as string,
		workspace.taskExpiresAt,
		fetcher,
		now,
	);

	if (task.kind === "succeeded") {
		return finishProvisioning(db, lease, now, "clone_confirmed");
	}
	if (task.kind === "failed") {
		failWorkspaceProvision(db, lease, "clone_task_failed", task.message, now);

		return { processed: 1, status: "task_failed" };
	}
	if (task.kind === "timed_out") {
		failWorkspaceProvision(
			db,
			lease,
			"clone_task_timeout",
			"proxmox clone task did not finish before its deadline",
			now,
		);

		return { processed: 1, status: "task_failed" };
	}

	releaseWorkspaceOperation(db, lease, POLL_INTERVAL_MS, now);

	return { processed: 1, status: "awaiting_task" };
}

// reconcileCandidate recovers from a lost clone response.
//
// A persisted VMID with no UPID means the controller stopped between recording the candidate and
// recording the clone task, so the clone may or may not have landed. Proxmox is the only source of
// truth here, and the container is never modified whatever the answer is.
async function reconcileCandidate(
	db: Database.Database,
	config: ControllerConfig,
	lease: OperationLease,
	workspace: WorkspaceProvision,
	fetcher: Fetcher,
	now: Date,
): Promise<WorkspaceOperationRun> {
	const api = workspaceNode(config, workspace);
	const container = await containerConfig(
		api,
		workspace.vmid as number,
		fetcher,
	);

	if (container.kind === "failed") {
		noteWorkspaceIssue(db, lease, container.message, now);
		releaseWorkspaceOperation(db, lease, POLL_INTERVAL_MS, now);

		return { processed: 1, status: "awaiting_reconciliation" };
	}

	if (container.kind === "forbidden") {
		// A pool-scoped token cannot read a guest outside its pool, so this covers a VMID that is
		// free, deleted, or someone else's alike. None of them may be adopted.
		const membership = await poolContainsVMID(
			api,
			config.PROXMOX_POOL as string,
			workspace.vmid as number,
			fetcher,
		);
		if (membership.kind === "failed") {
			noteWorkspaceIssue(db, lease, membership.message, now);
			releaseWorkspaceOperation(db, lease, POLL_INTERVAL_MS, now);

			return { processed: 1, status: "awaiting_reconciliation" };
		}
		if (membership.kind === "outside") {
			releaseWorkspaceCandidateVMID(
				db,
				lease,
				"candidate VMID is not in the controller pool and was left untouched",
				now,
			);
			releaseWorkspaceOperation(db, lease, 0, now);

			return { processed: 1, status: "vmid_released" };
		}

		releaseWorkspaceOperation(db, lease, POLL_INTERVAL_MS, now);

		return { processed: 1, status: "awaiting_reconciliation" };
	}

	if (container.kind === "missing") {
		// "Does not exist" covers both a clone that never started and one still creating the
		// guest, so Proxmox's task list decides between them. Guessing wrong in this direction
		// orphans a real container wearing this workspace's ownership marker.
		const running = await runningCloneTask(
			api,
			workspace.vmid as number,
			fetcher,
		);
		if (running.kind === "failed") {
			releaseWorkspaceOperation(db, lease, POLL_INTERVAL_MS, now);

			return { processed: 1, status: "awaiting_reconciliation" };
		}
		if (running.kind === "found") {
			// The lost UPID is recoverable after all. Resume polling it instead of cloning again.
			recordWorkspaceTask(
				db,
				lease,
				{
					expiresAt: taskExpiry(now),
					kind: "provision",
					step: "clone task accepted",
					upid: running.upid,
				},
				now,
			);
			releaseWorkspaceOperation(db, lease, POLL_INTERVAL_MS, now);

			return { processed: 1, status: "task_recovered" };
		}

		// Nothing was created and nothing is being created. Allocate a fresh candidate rather than
		// reusing this VMID, which another Proxmox client may have taken in the meantime.
		releaseWorkspaceCandidateVMID(
			db,
			lease,
			"candidate VMID has no container and no running clone; a new candidate will be requested",
			now,
		);
		releaseWorkspaceOperation(db, lease, 0, now);

		return { processed: 1, status: "vmid_released" };
	}

	const marker = parseOwnershipMarker(containerDescription(container.config));
	if (
		!ownershipMatches(marker, {
			controllerID: config.CONTROLLER_ID as string,
			ownershipToken: workspace.ownershipToken,
			workspaceID: workspace.id,
		})
	) {
		// The container belongs to another controller, another workspace, or another tool. Walk
		// away from the VMID and leave the container entirely alone.
		releaseWorkspaceCandidateVMID(
			db,
			lease,
			"candidate VMID belongs to an unverified container and was left untouched",
			now,
		);
		releaseWorkspaceOperation(db, lease, 0, now);

		return { processed: 1, status: "vmid_released" };
	}

	return finishProvisioning(db, lease, now, "vmid_adopted");
}

// finishProvisioning records the confirmed clone and hands off to the boot step.
function finishProvisioning(
	db: Database.Database,
	lease: OperationLease,
	now: Date,
	status: WorkspaceOperationRun["status"],
): WorkspaceOperationRun {
	confirmWorkspaceClone(db, lease, now);
	advanceWorkspaceProvision(
		db,
		lease,
		{ phase: "clone-confirmed", step: "clone confirmed" },
		now,
	);
	releaseWorkspaceOperation(db, lease, 0, now);

	return { processed: 1, status };
}

// submitClone allocates a candidate VMID and submits the linked clone.
async function submitClone(
	db: Database.Database,
	config: ControllerConfig,
	lease: OperationLease,
	workspace: WorkspaceProvision,
	fetcher: Fetcher,
	now: Date,
): Promise<WorkspaceOperationRun> {
	const api = proxmoxCredentials(config);
	// A configured floor keeps disposable workspaces in their own VMID band, away from guests
	// built by hand.
	const floor = config.PROXMOX_VMID_MIN;
	const vmid =
		floor === undefined
			? await nextProxmoxVMID(api, fetcher)
			: await allocateProxmoxVMID(api, fetcher, floor, reservedVMIDs(db));
	if (vmid.kind === "failed") {
		noteWorkspaceIssue(db, lease, vmid.message, now);
		releaseWorkspaceOperation(db, lease, POLL_INTERVAL_MS, now);

		return { processed: 1, status: "request_failed" };
	}

	const prepared = prepareWorkspaceProvision(
		db,
		lease,
		api.node,
		vmid.vmid,
		now,
	);
	if (prepared.kind !== "prepared") {
		return { processed: 1, status: "stale_operation" };
	}

	const clone = await cloneWorkspace(
		api,
		{
			controllerID: config.CONTROLLER_ID as string,
			createdAt: now.toISOString(),
			hostname: workspace.hostname,
			node: api.node,
			ownershipToken: workspace.ownershipToken,
			pool: config.PROXMOX_POOL as string,
			templateVMID: config.PROXMOX_TEMPLATE_VMID as number,
			vmid: vmid.vmid,
			workspaceID: workspace.id,
		},
		fetcher,
	);
	if (clone.kind === "failed") {
		// The outcome is unknown: the clone may still have been accepted. The persisted VMID sends
		// the next pass through reconciliation rather than blindly retrying the clone.
		noteWorkspaceIssue(db, lease, clone.message, now);
		releaseWorkspaceOperation(db, lease, POLL_INTERVAL_MS, now);

		return { processed: 1, status: "request_failed" };
	}

	const recorded = recordWorkspaceTask(
		db,
		lease,
		{
			expiresAt: taskExpiry(now),
			kind: "provision",
			phase: "clone-submitted",
			step: "clone task accepted",
			upid: clone.upid,
		},
		now,
	);
	if (recorded.kind !== "prepared") {
		return { processed: 1, status: "stale_operation" };
	}

	releaseWorkspaceOperation(db, lease, POLL_INTERVAL_MS, now);

	return { processed: 1, status: "clone_submitted" };
}
