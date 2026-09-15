import type Database from "better-sqlite3";
import type { ControllerConfig } from "../config/controller-config";

import {
	claimWorkspaceOperation,
	prepareWorkspaceProvision,
	recordWorkspaceTask,
	workspaceProvision,
} from "../db/workspace-repository";
import { cloneWorkspace, nextProxmoxVMID } from "./proxmox-clone";

// WorkspaceOperationRun is the durable outcome of one worker pass.
export type WorkspaceOperationRun = {
	processed: 0 | 1;
	status:
		| "awaiting_task"
		| "clone_submitted"
		| "disabled"
		| "empty"
		| "reconciliation_required"
		| "request_failed";
};

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

// runWorkspaceOperations submits at most one clone and stops at the persisted UPID boundary.
export async function runWorkspaceOperations(
	db: Database.Database,
	config: ControllerConfig,
	fetcher: Fetcher = fetch,
): Promise<WorkspaceOperationRun> {
	if (!config.provisioningEnabled) {
		return { processed: 0, status: "disabled" };
	}

	const claimed = claimWorkspaceOperation(db);
	if (claimed.kind === "empty") {
		return { processed: 0, status: "empty" };
	}
	if (claimed.operation.kind !== "provision") {
		return { processed: 1, status: "reconciliation_required" };
	}

	const workspace = workspaceProvision(db, claimed.operation.id);
	if (workspace === undefined) {
		return { processed: 1, status: "reconciliation_required" };
	}
	if (workspace.taskUPID !== undefined) {
		return { processed: 1, status: "awaiting_task" };
	}
	if (workspace.vmid !== undefined) {
		return { processed: 1, status: "reconciliation_required" };
	}

	const vmid = nextProxmoxVMID(
		config.PROXMOX_URL as string,
		config.PROXMOX_TOKEN_ID as string,
		config.PROXMOX_TOKEN_SECRET as string,
		fetcher,
	);

	return submitClone(
		db,
		config,
		claimed.operation.id,
		workspace,
		vmid,
		fetcher,
	);
}

async function submitClone(
	db: Database.Database,
	config: ControllerConfig,
	operationID: string,
	workspace: NonNullable<ReturnType<typeof workspaceProvision>>,
	vmidResult: ReturnType<typeof nextProxmoxVMID>,
	fetcher: Fetcher,
): Promise<WorkspaceOperationRun> {
	const vmid = await vmidResult;
	if (vmid.kind === "failed") {
		return { processed: 1, status: "request_failed" };
	}

	const prepared = prepareWorkspaceProvision(
		db,
		operationID,
		config.PROXMOX_NODE as string,
		vmid.vmid,
	);
	if (prepared.kind !== "prepared") {
		return { processed: 1, status: "reconciliation_required" };
	}

	const clone = await cloneWorkspace(
		config.PROXMOX_URL as string,
		config.PROXMOX_TOKEN_ID as string,
		config.PROXMOX_TOKEN_SECRET as string,
		{
			controllerID: config.CONTROLLER_ID as string,
			createdAt: new Date().toISOString(),
			hostname: workspace.hostname,
			node: config.PROXMOX_NODE as string,
			ownershipToken: workspace.ownershipToken,
			pool: config.PROXMOX_POOL as string,
			templateVMID: config.PROXMOX_TEMPLATE_VMID as number,
			vmid: vmid.vmid,
			workspaceID: workspace.id,
		},
		fetcher,
	);
	if (clone.kind === "failed") {
		return { processed: 1, status: "reconciliation_required" };
	}

	const recorded = recordWorkspaceTask(db, operationID, clone.upid);
	if (recorded.kind !== "prepared") {
		return { processed: 1, status: "reconciliation_required" };
	}

	return { processed: 1, status: "clone_submitted" };
}
