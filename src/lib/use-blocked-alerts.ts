import { useEffect, useRef, useState } from "react";

import { useFaviconAlert } from "./use-favicon-alert";

type Watched = {
	activity: string;
	hostname: string;
	id: string;
	status: string;
};

// NotificationPermissionState mirrors the browser's own values, plus the case where the API is not
// there at all: an insecure origin, or a browser without it.
export type AlertPermission = "denied" | "granted" | "prompt" | "unsupported";

// BASE_TITLE is restored whenever nothing is waiting, so the tab does not keep a stale count.
const BASE_TITLE = "Proxmox Agents";

// useBlockedAlerts makes a waiting agent noticeable without the page being watched.
//
// A blocked workspace is exempt from both reaping rules, so an unanswered dialog holds its
// container indefinitely. That is the right trade for not losing work, but it means the only thing
// standing between a question and a container running for a week is somebody noticing. The tab
// title carries the count with no permission needed; a notification is offered on top of it.
export function useBlockedAlerts(workspaces: Watched[]): {
	blocked: Watched[];
	permission: AlertPermission;
	requestPermission: () => void;
} {
	const [permission, setPermission] = useState<AlertPermission>("unsupported");
	// Which workspaces have already been announced, so a dialog left open for an hour does not
	// notify once a second for an hour.
	const announced = useRef<Set<string>>(new Set());

	useEffect(() => {
		setPermission(currentPermission());
	}, []);

	const blocked = workspaces.filter(
		(workspace) =>
			workspace.status === "ready" && workspace.activity === "blocked",
	);

	useEffect(() => {
		if (typeof document === "undefined") {
			return;
		}

		document.title =
			blocked.length === 0 ? BASE_TITLE : `(${blocked.length}) ${BASE_TITLE}`;
	}, [blocked.length]);

	// The same message in the one part of a background tab that is always drawn. A count in the
	// title says nothing to somebody whose tab strip is showing sixteen tabs and no text.
	useFaviconAlert(blocked.length > 0);

	useEffect(() => {
		if (typeof window === "undefined" || currentPermission() !== "granted") {
			return;
		}

		for (const workspace of blocked) {
			if (announced.current.has(workspace.id)) {
				continue;
			}

			announced.current.add(workspace.id);
			// tag replaces rather than stacks, so a workspace that blocks, is answered, and blocks
			// again does not leave a pile of notifications behind it.
			new Notification(`${workspace.hostname} is waiting`, {
				body: "The agent has asked a question and will not continue until it is answered.",
				tag: `workspace-${workspace.id}`,
			});
		}

		// Forgotten once answered, so the next question notifies again.
		const stillBlocked = new Set(blocked.map((workspace) => workspace.id));
		for (const id of announced.current) {
			if (!stillBlocked.has(id)) {
				announced.current.delete(id);
			}
		}
	}, [blocked]);

	return {
		blocked,
		permission,
		requestPermission: () => {
			if (typeof window === "undefined" || !("Notification" in window)) {
				return;
			}

			void Notification.requestPermission().then((result) =>
				setPermission(result === "default" ? "prompt" : result),
			);
		},
	};
}

function currentPermission(): AlertPermission {
	if (typeof window === "undefined" || !("Notification" in window)) {
		return "unsupported";
	}

	return Notification.permission === "default"
		? "prompt"
		: Notification.permission;
}
