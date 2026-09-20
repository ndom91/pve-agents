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
	recordWorkspaceInteraction,
	recordWorkspaceTask,
	releaseWorkspaceCandidateVMID,
	releaseWorkspaceOperation,
	reservedVMIDs,
	type WorkspaceProvision,
	workspaceProvision,
	workspaceRequest,
} from "../db/workspace-repository";
import { parseRepository } from "../domain/repository";
import { AGENT_CWD } from "../domain/workspace-layout";
import {
	installRunner,
	promptRunner,
	runnerSource,
	runnerState,
	startRunner,
} from "./agent-runner";
import { prepareClaudeWorkspace } from "./claude-agent";
import { type GitHubAppCredentials, installationToken } from "./github-app";
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
import { forgetHost, type SshRunner, type SshTarget } from "./ssh";
import { checkoutRepository } from "./workspace-checkout";
import {
	awaitTask,
	POLL_INTERVAL_MS,
	proxmoxCredentials,
	taskExpiry,
	type WorkspaceOperationRun,
	workspaceNode,
} from "./workspace-task";

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

// summarise shortens a purpose to the one line a timeline entry can hold.
//
// The timeline is scanned rather than read, and a purpose can run to paragraphs. Taking the first
// line rather than the first 120 characters, because a purpose that starts with a title says what
// it is in that title and truncating mid-sentence says almost nothing.
function summarise(purpose: string): string {
	const first = purpose.split("\n")[0]?.trim() ?? "";

	return first.length > 120 ? `${first.slice(0, 120)}...` : first;
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
			return startAgentRunner(db, config, lease, workspace, now, ssh);
		case "runner-started":
			return briefAgent(db, config, lease, workspace, now, ssh);
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

	// Drop any key pinned against this address before the first connection.
	//
	// The workspace is seconds old and its host keys were generated on first boot, so anything
	// already pinned for this address belongs to a container that no longer exists. DHCP hands out
	// the low addresses of the range over and over, so a workspace inheriting a predecessor's
	// address is routine rather than exceptional.
	//
	// Forgetting on destroy is not enough on its own, because it is a cleanup that can be missed:
	// by an orphan removed outside the teardown path, by a workspace destroyed before it ever had
	// an address, by a controller that stopped mid-teardown. One miss poisons the next workspace
	// to be handed that address, which is what happened.
	//
	// This does not weaken the protection that matters. Only the phase before a workspace is first
	// reachable runs this; once accept-new has pinned the real key, a change during the workspace's
	// life is still refused, and that is the case pinning actually defends against.
	await forgetHost(keyPath, workspace.ip as string);

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
// Before the runner rather than after, so the agent starts in a populated repository
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

// startAgentRunner installs the agent runner and waits for it to answer.
//
// Three Herdr phases collapse into this one. Starting a server, creating a workspace in it, and
// starting an agent in a pane were three round trips with three distinct failure vocabularies
// (`agent_name_taken`, `agent_not_ready`, `agent_prompt_stalled`) and a first-run wizard check on
// the end. A process either listens on its socket or it does not.
//
// Installing on every pass rather than once: writing one file is cheaper than recording whether it
// was written, and it means a controller deploy reaches a workspace whose runner died and is about
// to be restarted.
async function startAgentRunner(
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

	// Asked first, so a pass that already has a working runner costs one round trip rather than an
	// install and a launch.
	if ((await runnerState(target, ssh)) !== "running") {
		const installed = await installRunner(target, runnerSource(), ssh);
		if (installed.kind === "failed") {
			noteWorkspaceIssue(db, lease, installed.message, now);
			releaseWorkspaceOperation(db, lease, POLL_INTERVAL_MS, now);

			return { processed: 1, status: "awaiting_session" };
		}

		// "launched" is not "running": the start script backgrounds the process and exits, so a
		// runner that dies on a missing dependency launches perfectly. The next pass asks the
		// socket, which is the only thing that can answer.
		const launched = await startRunner(
			target,
			config.WORKSPACE_PERMISSION_MODE,
			ssh,
		);
		if (launched === "failed") {
			noteWorkspaceIssue(db, lease, "could not launch the agent runner", now);
		}
		releaseWorkspaceOperation(db, lease, POLL_INTERVAL_MS, now);

		return { processed: 1, status: "awaiting_session" };
	}

	advanceWorkspaceProvision(
		db,
		lease,
		{
			event: {
				message: `agent runner listening, permissions ${config.WORKSPACE_PERMISSION_MODE}`,
				type: "workspace.session_started",
			},
			phase: "runner-started",
			step: "agent runner running",
		},
		now,
	);
	releaseWorkspaceOperation(db, lease, 0, now);

	return { processed: 1, status: "session_started" };
}

// briefAgent tells the agent what the workspace was requested for.
//
// This is what makes "ready" mean working on it rather than merely built. The purpose is sent
// verbatim: wrapping it in invented context would hand the agent instructions the operator never
// wrote, and a terse prompt is better than a surprising one.
async function briefAgent(
	db: Database.Database,
	config: ControllerConfig,
	lease: OperationLease,
	workspace: WorkspaceProvision,
	now: Date,
	ssh: SshRunner,
): Promise<WorkspaceOperationRun> {
	const request = workspaceRequest(db, workspace.id);
	const purpose = request?.purpose?.trim();
	const target = workspaceSsh(config, workspace);

	// The one transition to ready, written once. Both paths below end here and differ only in what
	// the timeline is told, which is the whole of the difference between them.
	const ready = (message: string): WorkspaceOperationRun => {
		advanceWorkspaceProvision(
			db,
			lease,
			{
				event: { message, type: "workspace.ready" },
				phase: "briefed",
				status: "ready",
				step: "ready",
			},
			now,
		);
		completeWorkspaceOperation(db, lease, now);

		return { processed: 1, status: "workspace_ready" };
	};

	// Nothing to say. A workspace requested without a purpose is ready and idle, waiting for
	// someone to tell it something from the UI.
	if (purpose === undefined || purpose === "" || target === undefined) {
		return ready("workspace ready, awaiting instructions");
	}

	const prompted = await promptRunner(target, purpose, ssh);
	if (prompted === "failed") {
		noteWorkspaceIssue(db, lease, "could not brief the agent", now);
		releaseWorkspaceOperation(db, lease, POLL_INTERVAL_MS, now);

		return { processed: 1, status: "awaiting_agent" };
	}

	// The briefing is work given to the agent, so it starts the idle clock. Otherwise a workspace
	// that was briefed and answered quickly looks, to the reaper, like one that never did anything.
	recordWorkspaceInteraction(db, workspace.id, now);

	return ready(`briefed: ${summarise(purpose)}`);
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
