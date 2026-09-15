import type { ControllerConfig } from "../config/controller-config";

// ProxmoxCheck is one read-only infrastructure validation result.
export type ProxmoxCheck = {
	detail: string;
	name: "api" | "bridge" | "pool" | "storage" | "template";
	status: "error" | "ok" | "skipped";
};

// ProxmoxProbe is the complete result of validating controller infrastructure access.
export type ProxmoxProbe = {
	checks: ProxmoxCheck[];
	ok: boolean;
};

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

type ProxmoxResponse = {
	data: unknown;
};

// probeProxmox performs read-only checks against the configured Proxmox API.
export async function probeProxmox(
	config: ControllerConfig,
	fetcher: Fetcher = fetch,
): Promise<ProxmoxProbe> {
	const checks: ProxmoxCheck[] = [];
	const missing = missingApiConfig(config);
	if (missing.length > 0) {
		checks.push({
			detail: `missing ${missing.join(", ")}`,
			name: "api",
			status: "skipped",
		});

		return { checks, ok: false };
	}

	const api = apiConfig(config);
	const nextID = await request(api, fetcher, "/cluster/nextid");
	if (!nextID.ok) {
		checks.push({ detail: nextID.error, name: "api", status: "error" });

		return { checks, ok: false };
	}
	checks.push({
		detail: "token can read the next available VMID",
		name: "api",
		status: "ok",
	});

	const template = await request(
		api,
		fetcher,
		`/nodes/${encodeURIComponent(api.node)}/lxc/${api.templateVMID}/config`,
	);
	if (!template.ok) {
		checks.push({ detail: template.error, name: "template", status: "error" });

		return { checks, ok: false };
	}

	const templateConfig = record(template.data);
	if (templateConfig === undefined) {
		checks.push({
			detail: "Proxmox returned an invalid template configuration",
			name: "template",
			status: "error",
		});

		return { checks, ok: false };
	}
	checks.push(templateCheck(templateConfig, api.templateVMID));
	checks.push(await storageCheck(api, fetcher, templateConfig));
	checks.push(await poolCheck(api, config, fetcher));
	checks.push(await bridgeCheck(api, config, fetcher, templateConfig));

	return { checks, ok: checksAreOK(checks) };
}

function apiConfig(config: ControllerConfig) {
	return {
		node: config.PROXMOX_NODE as string,
		templateVMID: config.PROXMOX_TEMPLATE_VMID as number,
		tokenID: config.PROXMOX_TOKEN_ID as string,
		tokenSecret: config.PROXMOX_TOKEN_SECRET as string,
		url: config.PROXMOX_URL as string,
	};
}

async function bridgeCheck(
	api: ReturnType<typeof apiConfig>,
	config: ControllerConfig,
	fetcher: Fetcher,
	template: Record<string, unknown>,
): Promise<ProxmoxCheck> {
	const bridge = bridgeName(stringValue(template.net0));
	if (config.PROXMOX_BRIDGE === undefined) {
		let detail = "PROXMOX_BRIDGE is not configured";
		if (bridge !== undefined) {
			detail = `PROXMOX_BRIDGE is not configured; template uses ${bridge}`;
		}

		return { detail, name: "bridge", status: "skipped" };
	}
	if (bridge === undefined) {
		return {
			detail: "template net0 does not declare a bridge",
			name: "bridge",
			status: "error",
		};
	}
	if (!usesDHCP(stringValue(template.net0))) {
		return {
			detail: "template net0 must use IPv4 DHCP",
			name: "bridge",
			status: "error",
		};
	}
	if (bridge !== config.PROXMOX_BRIDGE) {
		return {
			detail: `configured bridge ${config.PROXMOX_BRIDGE} differs from template bridge ${bridge}`,
			name: "bridge",
			status: "error",
		};
	}

	const network = await request(
		api,
		fetcher,
		`/nodes/${encodeURIComponent(api.node)}/network`,
	);
	if (!network.ok) {
		return { detail: network.error, name: "bridge", status: "error" };
	}
	if (!hasRecordValue(network.data, "iface", bridge)) {
		return {
			detail: `bridge ${bridge} was not found on node ${api.node}`,
			name: "bridge",
			status: "error",
		};
	}

	return {
		detail: `bridge ${bridge} exists on ${api.node}`,
		name: "bridge",
		status: "ok",
	};
}

function bridgeName(net: string | undefined): string | undefined {
	if (net === undefined) {
		return undefined;
	}

	for (const option of net.split(",")) {
		if (option.startsWith("bridge=")) {
			return option.slice("bridge=".length);
		}
	}

	return undefined;
}

function usesDHCP(net: string | undefined): boolean {
	if (net === undefined) {
		return false;
	}

	for (const option of net.split(",")) {
		if (option === "ip=dhcp") {
			return true;
		}
	}

	return false;
}

function checksAreOK(checks: ProxmoxCheck[]): boolean {
	for (const check of checks) {
		if (check.status !== "ok") {
			return false;
		}
	}

	return true;
}

function missingApiConfig(config: ControllerConfig): string[] {
	const missing: string[] = [];
	for (const key of [
		"PROXMOX_NODE",
		"PROXMOX_TEMPLATE_VMID",
		"PROXMOX_TOKEN_ID",
		"PROXMOX_TOKEN_SECRET",
		"PROXMOX_URL",
	] as const) {
		if (config[key] === undefined) {
			missing.push(key);
		}
	}

	return missing;
}

async function poolCheck(
	api: ReturnType<typeof apiConfig>,
	config: ControllerConfig,
	fetcher: Fetcher,
): Promise<ProxmoxCheck> {
	if (config.PROXMOX_POOL === undefined) {
		return {
			detail: "PROXMOX_POOL is not configured",
			name: "pool",
			status: "skipped",
		};
	}

	const pools = await request(api, fetcher, "/pools");
	if (!pools.ok) {
		return { detail: pools.error, name: "pool", status: "error" };
	}
	if (!hasRecordValue(pools.data, "poolid", config.PROXMOX_POOL)) {
		return {
			detail: `pool ${config.PROXMOX_POOL} was not found`,
			name: "pool",
			status: "error",
		};
	}

	return {
		detail: `pool ${config.PROXMOX_POOL} exists`,
		name: "pool",
		status: "ok",
	};
}

function record(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}

	return value as Record<string, unknown>;
}

async function request(
	api: ReturnType<typeof apiConfig>,
	fetcher: Fetcher,
	path: string,
): Promise<{ data: unknown; ok: true } | { error: string; ok: false }> {
	let response: Response;
	try {
		response = await fetcher(`${urlWithoutTrailingSlash(api.url)}${path}`, {
			headers: {
				Accept: "application/json",
				Authorization: `PVEAPIToken=${api.tokenID}=${api.tokenSecret}`,
			},
			method: "GET",
		});
	} catch {
		return { error: `Proxmox request ${path} failed`, ok: false };
	}

	if (!response.ok) {
		return {
			error: `Proxmox request ${path} returned HTTP ${response.status}`,
			ok: false,
		};
	}

	let result: ProxmoxResponse;
	try {
		result = (await response.json()) as ProxmoxResponse;
	} catch {
		return {
			error: `Proxmox request ${path} returned invalid JSON`,
			ok: false,
		};
	}

	return { data: result.data, ok: true };
}

async function storageCheck(
	api: ReturnType<typeof apiConfig>,
	fetcher: Fetcher,
	template: Record<string, unknown>,
): Promise<ProxmoxCheck> {
	const rootfs = stringValue(template.rootfs);
	if (rootfs === undefined) {
		return {
			detail: "template does not declare a rootfs",
			name: "storage",
			status: "error",
		};
	}

	const separator = rootfs.indexOf(":");
	if (separator < 1) {
		return {
			detail: `template rootfs has invalid storage reference ${rootfs}`,
			name: "storage",
			status: "error",
		};
	}

	const storage = rootfs.slice(0, separator);
	const storages = await request(api, fetcher, "/storage");
	if (!storages.ok) {
		return { detail: storages.error, name: "storage", status: "error" };
	}
	if (!hasRecordValue(storages.data, "storage", storage)) {
		return {
			detail: `template rootfs storage ${storage} was not found`,
			name: "storage",
			status: "error",
		};
	}

	return {
		detail: `template rootfs storage ${storage} exists`,
		name: "storage",
		status: "ok",
	};
}

function stringValue(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}

	return value;
}

function hasRecordValue(data: unknown, key: string, value: string): boolean {
	if (!Array.isArray(data)) {
		return false;
	}

	for (const item of data) {
		const candidate = record(item);
		if (candidate === undefined) {
			continue;
		}
		if (candidate[key] === value) {
			return true;
		}
	}

	return false;
}

function templateCheck(
	template: Record<string, unknown>,
	templateVMID: number,
): ProxmoxCheck {
	if (template.template !== 1) {
		return {
			detail: `LXC ${templateVMID} is not a Proxmox template`,
			name: "template",
			status: "error",
		};
	}
	if (template.unprivileged !== 1) {
		return {
			detail: `template ${templateVMID} is not unprivileged`,
			name: "template",
			status: "error",
		};
	}

	return {
		detail: `template ${templateVMID} is unprivileged`,
		name: "template",
		status: "ok",
	};
}

function urlWithoutTrailingSlash(url: string): string {
	if (url.endsWith("/")) {
		return url.slice(0, -1);
	}

	return url;
}
