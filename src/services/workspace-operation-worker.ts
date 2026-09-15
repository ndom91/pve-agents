import type { ControllerConfig } from "../config/controller-config";

export type WorkspaceOperationRun = {
	processed: 0;
	status: "adapter_unavailable" | "disabled";
};

// runWorkspaceOperations keeps queued work inert until a Proxmox adapter is implemented.
export function runWorkspaceOperations(
	config: ControllerConfig,
): WorkspaceOperationRun {
	if (!config.provisioningEnabled) {
		return { processed: 0, status: "disabled" };
	}

	return { processed: 0, status: "adapter_unavailable" };
}
