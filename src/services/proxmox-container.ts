import {
	type Fetcher,
	type ProxmoxCredentials,
	type ProxmoxTaskRequest,
	proxmoxHeaders,
	proxmoxTimeout,
	proxmoxURL,
	submitProxmoxTask,
} from "./proxmox-http";

// SHUTDOWN_TIMEOUT_SECONDS bounds how long Proxmox waits for a guest to shut down cleanly.
//
// The controller escalates to a forced stop after this, so the value only decides how long a
// well-behaved guest is given, not whether teardown eventually completes.
const SHUTDOWN_TIMEOUT_SECONDS = 60;

// ProxmoxContainerState is the runtime state of one LXC.
export type ProxmoxContainerState =
	| { kind: "failed"; message: string }
	| { kind: "forbidden" }
	| { kind: "missing" }
	| { kind: "running" }
	| { kind: "stopped" };

// ProxmoxContainerConfig is the result of reading one LXC configuration.
//
// "missing" and "failed" must stay distinct: an absent LXC is a durable fact the controller acts
// on, while a failed request tells us nothing and must only be retried.
export type ProxmoxContainerConfig =
	| { config: Record<string, unknown>; kind: "found" }
	| { kind: "failed"; message: string }
	| { kind: "forbidden" }
	| { kind: "missing" };

// containerConfig reads one LXC configuration without modifying it.
export async function containerConfig(
	api: ProxmoxCredentials,
	vmid: number,
	fetcher: Fetcher,
): Promise<ProxmoxContainerConfig> {
	const read = await readContainer(
		api,
		`/nodes/${encodeURIComponent(api.node)}/lxc/${vmid}/config`,
		`config request for ${vmid}`,
		fetcher,
	);
	if (read.kind !== "found") {
		return read;
	}

	return { config: read.data, kind: "found" };
}

// containerState reads whether one LXC is currently running.
export async function containerState(
	api: ProxmoxCredentials,
	vmid: number,
	fetcher: Fetcher,
): Promise<ProxmoxContainerState> {
	const read = await readContainer(
		api,
		`/nodes/${encodeURIComponent(api.node)}/lxc/${vmid}/status/current`,
		`status request for ${vmid}`,
		fetcher,
	);
	if (read.kind !== "found") {
		return read;
	}

	// Anything that is not explicitly stopped is treated as running, so an unfamiliar transitional
	// state routes through shutdown and force-stop rather than straight to delete.
	if (read.data.status === "stopped") {
		return { kind: "stopped" };
	}
	if (typeof read.data.status !== "string") {
		return {
			kind: "failed",
			message: `proxmox status request for ${vmid} reported no state`,
		};
	}

	return { kind: "running" };
}

// startContainer boots one LXC.
export function startContainer(
	api: ProxmoxCredentials,
	vmid: number,
	fetcher: Fetcher,
): Promise<ProxmoxTaskRequest> {
	return submitProxmoxTask(
		proxmoxURL(
			api.apiURL,
			`/nodes/${encodeURIComponent(api.node)}/lxc/${vmid}/status/start`,
		),
		{
			headers: proxmoxHeaders(api.tokenID, api.tokenSecret),
			method: "POST",
		},
		"start",
		fetcher,
	);
}

// shutdownContainer asks one LXC to stop cleanly within a bounded timeout.
export function shutdownContainer(
	api: ProxmoxCredentials,
	vmid: number,
	fetcher: Fetcher,
): Promise<ProxmoxTaskRequest> {
	// forceStop=0 keeps escalation a decision the controller makes and records, rather than one
	// Proxmox takes silently when the timeout expires.
	return submitProxmoxTask(
		proxmoxURL(
			api.apiURL,
			`/nodes/${encodeURIComponent(api.node)}/lxc/${vmid}/status/shutdown`,
		),
		{
			body: new URLSearchParams({
				forceStop: "0",
				timeout: SHUTDOWN_TIMEOUT_SECONDS.toString(),
			}),
			headers: {
				...proxmoxHeaders(api.tokenID, api.tokenSecret),
				"Content-Type": "application/x-www-form-urlencoded",
			},
			method: "POST",
		},
		"shutdown",
		fetcher,
	);
}

// stopContainer forcibly stops one LXC after a clean shutdown failed.
export function stopContainer(
	api: ProxmoxCredentials,
	vmid: number,
	fetcher: Fetcher,
): Promise<ProxmoxTaskRequest> {
	return submitProxmoxTask(
		proxmoxURL(
			api.apiURL,
			`/nodes/${encodeURIComponent(api.node)}/lxc/${vmid}/status/stop`,
		),
		{
			headers: proxmoxHeaders(api.tokenID, api.tokenSecret),
			method: "POST",
		},
		"stop",
		fetcher,
	);
}

// deleteContainer destroys one stopped LXC and purges its references.
export function deleteContainer(
	api: ProxmoxCredentials,
	vmid: number,
	fetcher: Fetcher,
): Promise<ProxmoxTaskRequest> {
	// purge=1 removes the LXC from backup and HA references. destroy-unreferenced-disks is
	// deliberately omitted: it can reach storage this controller never created.
	return submitProxmoxTask(
		proxmoxURL(
			api.apiURL,
			`/nodes/${encodeURIComponent(api.node)}/lxc/${vmid}?purge=1`,
		),
		{
			headers: proxmoxHeaders(api.tokenID, api.tokenSecret),
			method: "DELETE",
		},
		"delete",
		fetcher,
	);
}

// containerDescription returns the LXC description carrying the ownership marker.
export function containerDescription(
	config: Record<string, unknown>,
): string | undefined {
	if (typeof config.description !== "string") {
		return undefined;
	}

	return config.description;
}

async function readContainer(
	api: ProxmoxCredentials,
	path: string,
	label: string,
	fetcher: Fetcher,
): Promise<
	| { data: Record<string, unknown>; kind: "found" }
	| { kind: "failed"; message: string }
	| { kind: "forbidden" }
	| { kind: "missing" }
> {
	let response: Response;
	try {
		response = await fetcher(proxmoxURL(api.apiURL, path), {
			headers: proxmoxHeaders(api.tokenID, api.tokenSecret),
			method: "GET",
			signal: proxmoxTimeout(),
		});
	} catch {
		return { kind: "failed", message: `proxmox ${label} failed` };
	}

	if (!response.ok) {
		// Proxmox reports an unknown LXC as 500 with an explanatory body rather than 404, so the
		// body has to be inspected before a 5xx can be dismissed as transient.
		if (response.status === 404) {
			return { kind: "missing" };
		}
		// A pool-scoped token gets 403 for every guest outside its pool, whether it was deleted,
		// never existed, or belongs to someone else. Only the pool listing can tell those apart.
		if (response.status === 403) {
			return { kind: "forbidden" };
		}

		const body = await response.text().catch(() => "");
		if (/does not exist/i.test(body)) {
			return { kind: "missing" };
		}

		return {
			kind: "failed",
			message: `proxmox ${label} returned HTTP ${response.status}`,
		};
	}

	const result = (await response.json().catch(() => undefined)) as
		| { data?: unknown }
		| undefined;
	const data = result?.data;
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		return {
			kind: "failed",
			message: `proxmox ${label} returned invalid JSON`,
		};
	}

	return { data: data as Record<string, unknown>, kind: "found" };
}
