import { lookup } from "node:dns/promises";

// controllerHost is the address a forwarded port is reached by.
//
// An IP resolved from CONTROLLER_URL, not the hostname. Vite 403s a Host header it does not
// recognise ("This host (pve-agents.puff.lan) is not allowed") but allows IP literals by default,
// and Next checks the same way.
//
// Only a successful lookup is cached. The hostname fallback is a guess, so the next read retries.
const RESOLVED = new Map<string, string>();

export async function controllerHost(controllerUrl: string): Promise<string> {
	const cached = RESOLVED.get(controllerUrl);
	if (cached !== undefined) {
		return cached;
	}

	let name = controllerUrl;
	try {
		name = new URL(controllerUrl).hostname;
	} catch {
		// Not a URL. Use it as written.
	}

	try {
		const { address } = await lookup(name);
		RESOLVED.set(controllerUrl, address);

		return address;
	} catch {
		return name;
	}
}
