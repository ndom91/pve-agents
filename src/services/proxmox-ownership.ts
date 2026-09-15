// MANAGED_BY is the marker value proving an LXC was created by this controller software.
export const MANAGED_BY = "pve-herdr-agents";

// WorkspaceOwnership is the identity written into a managed LXC description.
export type WorkspaceOwnership = {
	controllerID: string;
	createdAt: string;
	ownershipToken: string;
	workspaceID: string;
};

// ownershipMarker returns the metadata required to authorize future destructive actions.
//
// The description is the primary ownership proof because it is the only metadata that can be
// supplied atomically during the clone. Pool membership, hostname, and tags are discovery aids
// and are never sufficient authorization on their own.
export function ownershipMarker(input: WorkspaceOwnership): string {
	return [
		`managed-by=${MANAGED_BY}`,
		`controller-id=${input.controllerID}`,
		`workspace-id=${input.workspaceID}`,
		`ownership-token=${input.ownershipToken}`,
		`created-at=${input.createdAt}`,
	].join("\n");
}

// parseOwnershipMarker reads the key/value marker back out of an LXC description.
export function parseOwnershipMarker(
	description: string | undefined,
): Record<string, string> {
	const marker: Record<string, string> = {};
	if (description === undefined) {
		return marker;
	}

	for (const line of description.split("\n")) {
		const separator = line.indexOf("=");
		if (separator < 1) {
			continue;
		}

		marker[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
	}

	return marker;
}

// ownershipMatches reports whether an LXC description proves this controller owns the container.
//
// Every field must match exactly. A partial match means the LXC belongs to another controller,
// another workspace, or another tool, and it must never be adopted or modified.
export function ownershipMatches(
	marker: Record<string, string>,
	expected: Pick<
		WorkspaceOwnership,
		"controllerID" | "ownershipToken" | "workspaceID"
	>,
): boolean {
	return (
		marker["managed-by"] === MANAGED_BY &&
		marker["controller-id"] === expected.controllerID &&
		marker["workspace-id"] === expected.workspaceID &&
		marker["ownership-token"] === expected.ownershipToken
	);
}
