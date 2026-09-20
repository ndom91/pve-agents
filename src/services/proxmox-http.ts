// Fetcher is the injectable HTTP transport used by every Proxmox adapter.
export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

// ProxmoxCredentials is everything needed to address one Proxmox node.
//
// Passed as one object because the three token fields were previously splatted positionally at
// every call site, where transposing two strings would have type-checked cleanly.
export type ProxmoxCredentials = {
	apiURL: string;
	node: string;
	tokenID: string;
	tokenSecret: string;
};

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

// ProxmoxRead is one Proxmox response that got as far as carrying a `data` field.
//
// What is *in* `data` is the caller's problem: a UPID, an array of interfaces, a pool listing. Only
// the four steps every one of them shares are settled here.
export type ProxmoxRead =
	| { data: unknown; kind: "read" }
	| { kind: "failed"; message: string };

// proxmoxRead performs one request and gets as far as its `data` field.
//
// The transport half of every Proxmox call: reach it, check the status, parse the body, confirm
// there is a `data` to read. Four modules spelled this out independently, which meant four places
// to change the timeout and four chances for one of them to report a network failure as something
// else.
//
// `label` is the request named as the operator would see it -- "pool request for agents", "next
// VMID request" -- and it is the whole of the error message, so the wording of a failure lives
// here rather than being reassembled per call site.
export async function proxmoxRead(
	url: string,
	init: RequestInit,
	label: string,
	fetcher: Fetcher,
): Promise<ProxmoxRead> {
	let response: Response;
	try {
		response = await fetcher(url, { ...init, signal: proxmoxTimeout() });
	} catch {
		return { kind: "failed", message: `proxmox ${label} failed` };
	}

	if (!response.ok) {
		return {
			kind: "failed",
			message: `proxmox ${label} returned HTTP ${response.status}`,
		};
	}

	const result = (await response.json().catch(() => undefined)) as
		| { data?: unknown }
		| undefined;
	if (result === undefined) {
		return proxmoxUnreadable(label);
	}

	// `data` may be absent, and that is not decided here: a missing UPID and a missing pool
	// listing are different failures with different wording, and only the caller knows which.
	return { data: result.data, kind: "read" };
}

// proxmoxUnreadable is the answer that arrived but did not hold what was asked for.
//
// Exported because the shape check belongs to the caller -- only it knows whether it wanted an
// array, a string or a number -- while the wording belongs here, so one bad body does not read as
// three different problems depending on which call made it.
export function proxmoxUnreadable(label: string): {
	kind: "failed";
	message: string;
} {
	return {
		kind: "failed",
		message: `proxmox ${label} returned invalid JSON`,
	};
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
	const read = await proxmoxRead(url, init, `${label} request`, fetcher);
	if (read.kind === "failed") {
		return read;
	}

	if (typeof read.data !== "string") {
		return {
			kind: "failed",
			message: `proxmox ${label} request returned no UPID`,
		};
	}

	return { kind: "accepted", upid: read.data };
}
