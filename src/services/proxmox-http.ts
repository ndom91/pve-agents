// Fetcher is the injectable HTTP transport used by every Proxmox adapter.
export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

// PROXMOX_REQUEST_TIMEOUT_MS bounds every call to Proxmox.
//
// Without it a half-open connection hangs fetch forever, which parks the scheduler loop on an
// await it can never leave: no further operation is claimed and SIGTERM cannot stop it. Every
// Proxmox request either returns a task identifier or reads small JSON, so none legitimately runs
// this long.
export const PROXMOX_REQUEST_TIMEOUT_MS = 30_000;

// proxmoxTimeout returns the abort signal guarding one Proxmox request.
//
// A timeout surfaces as a rejected fetch, which every adapter already treats as transient, so a
// slow Proxmox retries rather than failing a workspace.
export function proxmoxTimeout(): AbortSignal {
	return AbortSignal.timeout(PROXMOX_REQUEST_TIMEOUT_MS);
}

// proxmoxHeaders returns the read headers for one token-authenticated Proxmox request.
export function proxmoxHeaders(
	tokenID: string,
	tokenSecret: string,
): Record<string, string> {
	return {
		Accept: "application/json",
		Authorization: `PVEAPIToken=${tokenID}=${tokenSecret}`,
	};
}

// proxmoxURL joins an API base with a path without producing a duplicate separator.
export function proxmoxURL(apiURL: string, path: string): string {
	if (apiURL.endsWith("/")) {
		return `${apiURL.slice(0, -1)}${path}`;
	}

	return `${apiURL}${path}`;
}

// ProxmoxTaskRequest is the result of submitting one asynchronous Proxmox action.
export type ProxmoxTaskRequest =
	| { kind: "accepted"; upid: string }
	| { kind: "failed"; message: string };

// submitProxmoxTask performs a request whose response body is a bare UPID string.
//
// Clone, shutdown, stop, and delete all answer this way, and every one of them must surface a
// missing UPID as a failure rather than silently reporting success for work nobody can poll.
export async function submitProxmoxTask(
	url: string,
	init: RequestInit,
	label: string,
	fetcher: Fetcher,
): Promise<ProxmoxTaskRequest> {
	let response: Response;
	try {
		response = await fetcher(url, { ...init, signal: proxmoxTimeout() });
	} catch {
		return { kind: "failed", message: `proxmox ${label} request failed` };
	}

	if (!response.ok) {
		return {
			kind: "failed",
			message: `proxmox ${label} request returned HTTP ${response.status}`,
		};
	}

	const result = (await response.json().catch(() => undefined)) as
		| { data?: unknown }
		| undefined;
	if (result === undefined) {
		return {
			kind: "failed",
			message: `proxmox ${label} request returned invalid JSON`,
		};
	}
	if (typeof result.data !== "string") {
		return {
			kind: "failed",
			message: `proxmox ${label} request returned no UPID`,
		};
	}

	return { kind: "accepted", upid: result.data };
}
