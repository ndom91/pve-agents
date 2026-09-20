import {
	type Fetcher,
	type ProxmoxCredentials,
	proxmoxHeaders,
	proxmoxRead,
	proxmoxUnreadable,
	proxmoxURL,
} from "./proxmox-http";

// ProxmoxAddress is the result of looking for a workspace's IPv4 address.
//
// "pending" is not a failure: DHCP has not answered yet, which is ordinary for the first seconds
// after boot and must be retried rather than failing the workspace.
export type ProxmoxAddress =
	| { address: string; kind: "found" }
	| { kind: "failed"; message: string }
	| { kind: "pending" };

// containerAddress returns the workspace's address on the expected network.
//
// Prefers eth0, which is what the template's net0 provides. Loopback and link-local are ignored:
// a link-local address means DHCP has not answered, not that the container is reachable.
export async function containerAddress(
	api: ProxmoxCredentials,
	vmid: number,
	subnet: string | undefined,
	fetcher: Fetcher,
): Promise<ProxmoxAddress> {
	const label = `interfaces request for ${vmid}`;
	const read = await proxmoxRead(
		proxmoxURL(
			api.apiURL,
			`/nodes/${encodeURIComponent(api.node)}/lxc/${vmid}/interfaces`,
		),
		{
			headers: proxmoxHeaders(api.tokenID, api.tokenSecret),
			method: "GET",
		},
		label,
		fetcher,
	);
	if (read.kind === "failed") {
		return read;
	}
	if (!Array.isArray(read.data)) {
		return proxmoxUnreadable(label);
	}

	const candidates: Array<{ address: string; name: string }> = [];
	for (const entry of read.data) {
		if (typeof entry !== "object" || entry === null) {
			continue;
		}

		const link = entry as { inet?: unknown; name?: unknown };
		if (typeof link.name !== "string" || link.name === "lo") {
			continue;
		}
		if (typeof link.inet !== "string") {
			continue;
		}

		// Proxmox reports this in CIDR form.
		const address = link.inet.split("/")[0] ?? "";
		if (!usable(address) || !inSubnet(address, subnet)) {
			continue;
		}

		candidates.push({ address, name: link.name });
	}

	const chosen =
		candidates.find((link) => link.name === "eth0") ?? candidates[0];

	return chosen === undefined
		? { kind: "pending" }
		: { address: chosen.address, kind: "found" };
}

function usable(address: string): boolean {
	if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(address)) {
		return false;
	}

	return !address.startsWith("127.") && !address.startsWith("169.254.");
}

// inSubnet keeps a container's own bridges, such as docker0, from being mistaken for its address.
function inSubnet(address: string, subnet: string | undefined): boolean {
	if (subnet === undefined) {
		return true;
	}

	const [network, bits] = subnet.split("/");
	const prefix = Number.parseInt(bits ?? "", 10);
	if (network === undefined || !Number.isInteger(prefix)) {
		return false;
	}

	const mask = prefix === 0 ? 0 : (-1 << (32 - prefix)) >>> 0;

	return (toNumber(address) & mask) === (toNumber(network) & mask);
}

function toNumber(address: string): number {
	return (
		address
			.split(".")
			.reduce((total, octet) => total * 256 + Number.parseInt(octet, 10), 0) >>>
		0
	);
}
