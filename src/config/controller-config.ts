import { z } from "zod";

const envSchema = z
	.object({
		CONTROLLER_AUTH_SECRET: z.string().min(32).optional(),
		CONTROLLER_ID: z.string().uuid().optional(),
		// The numeric GitHub account id allowed to sign in, not the login. Logins are reusable
		// after an account is deleted; the numeric id is not.
		CONTROLLER_OPERATOR_GITHUB_ID: z.string().min(1).optional(),
		CONTROLLER_URL: z.url().default("http://127.0.0.1:3000"),
		DATABASE_PATH: z.string().min(1).default("./data/controller.db"),
		// The GitHub App the controller clones as. Optional like the Claude token: a controller
		// that only builds containers has no repository to fetch, and the checkout step fails with
		// a named reason when these are missing rather than refusing to start.
		//
		// Distinct from GITHUB_CLIENT_ID/SECRET below, which are the OAuth app operators sign in
		// with. Different credential, different purpose, easy to confuse.
		GITHUB_APP_ID: z.string().min(1).optional(),
		GITHUB_APP_INSTALLATION_ID: z.string().min(1).optional(),
		GITHUB_APP_PRIVATE_KEY_PATH: z.string().min(1).optional(),
		GITHUB_CLIENT_ID: z.string().min(1).optional(),
		GITHUB_CLIENT_SECRET: z.string().min(1).optional(),
		// How old a stored git credential may get before it is replaced. Installation tokens last
		// an hour, so the default leaves a wide margin: a workspace should never be holding an
		// expired credential when its agent decides to push.
		GITHUB_TOKEN_REFRESH_SECONDS: z.coerce
			.number()
			.int()
			.min(60)
			.max(3000)
			.default(2400),
		PROVISIONING_ENABLED: z.enum(["false", "true"]).default("false"),
		PROXMOX_BRIDGE: z.string().min(1).optional(),
		PROXMOX_NODE: z.string().min(1).optional(),
		PROXMOX_POOL: z.string().min(1).optional(),
		PROXMOX_TEMPLATE_VMID: z.coerce.number().int().min(100).optional(),
		// The lowest VMID a workspace may be given. Left unset, Proxmox picks the next free id from
		// 100, which interleaves disposable workspaces with whatever else lives on the cluster.
		// Setting a floor keeps them in their own band, so they are recognisable at a glance and a
		// mistaken destroy cannot land on a hand-built guest.
		PROXMOX_VMID_MIN: z.coerce.number().int().min(100).max(999_999).optional(),
		PROXMOX_TOKEN_ID: z.string().min(1).optional(),
		PROXMOX_TOKEN_SECRET: z.string().min(1).optional(),
		PROXMOX_URL: z.url().optional(),
		// The scheduler stays off by default so the first real clone and purge are stepped by hand.
		WORKER_ENABLED: z.enum(["false", "true"]).default("false"),
		WORKER_INTERVAL_SECONDS: z.coerce
			.number()
			.int()
			.min(1)
			.max(3600)
			.default(5),
		// How stale an activity reading may get before it is taken again. Every reading costs one
		// SSH round trip per ready workspace, so this is the knob between a fresh fleet view and a
		// controller that spends its life reconnecting to idle containers.
		WORKSPACE_ACTIVITY_INTERVAL_SECONDS: z.coerce
			.number()
			.int()
			.min(5)
			.max(3600)
			.default(30),
		// The coding agent started in the workspace's first pane. Must be a kind Herdr recognises,
		// because Herdr refuses to start one it cannot detect afterwards.
		WORKSPACE_AGENT_KIND: z.string().min(1).default("claude"),
		// Which control plane a newly provisioned workspace gets.
		//
		// "sdk" runs the Agent SDK runner and talks to it over a socket. "herdr" runs Claude Code
		// as a TUI in a Herdr pane and reads the rendered screen. The second is what this was
		// built on and is being retired; the switch exists so both can be true at once while that
		// happens, because a workspace is disposable and the two never have to be migrated between
		// — an old one dies on its own.
		WORKSPACE_AGENT_RUNNER: z.enum(["herdr", "sdk"]).default("herdr"),
		// How much a workspace's agent may do without asking.
		//
		// "auto" is a second model reviewing each action rather than a person. Confirmed available
		// on the subscription token. When it is not available for a session — an unsupported model,
		// a settings file, a server-side decision — Claude Code silently runs Manual instead, which
		// degrades safely here because every call then reaches the approval UI.
		WORKSPACE_PERMISSION_MODE: z
			.enum(["acceptEdits", "auto", "bypassPermissions", "default", "plan"])
			.default("auto"),
		// A long-lived OAuth token from `claude setup-token`, tied to a Claude subscription. Not an
		// API key, and deliberately not required to start: a controller that only clones containers
		// has no use for it. The agent step fails with a named reason when it is missing.
		WORKSPACE_CLAUDE_OAUTH_TOKEN: z.string().min(1).optional(),
		WORKSPACE_HERDR_SESSION: z.string().min(1).default("agents"),
		// Restricts address discovery to the workspace network, so a container's own bridge is never
		// mistaken for its address. CIDR, for example 10.0.3.0/24.
		WORKSPACE_SUBNET: z.string().min(1).optional(),
		WORKSPACE_SSH_KEY_PATH: z.string().min(1).optional(),
		WORKSPACE_SSH_USER: z.string().min(1).default("agent"),
	})
	.superRefine((config, context) => {
		if (config.PROVISIONING_ENABLED === "false") {
			return;
		}

		// Provisioning turns the HTTP API into something that clones and purges real containers,
		// so the auth secret is required here rather than left to operator discipline.
		for (const key of [
			"CONTROLLER_AUTH_SECRET",
			"CONTROLLER_ID",
			"CONTROLLER_OPERATOR_GITHUB_ID",
			"GITHUB_CLIENT_ID",
			"GITHUB_CLIENT_SECRET",
			"PROXMOX_URL",
			"PROXMOX_TOKEN_ID",
			"PROXMOX_TOKEN_SECRET",
			"PROXMOX_NODE",
			"PROXMOX_TEMPLATE_VMID",
			"PROXMOX_POOL",
			"PROXMOX_BRIDGE",
		] as const) {
			if (config[key] === undefined) {
				context.addIssue({
					code: "custom",
					message: `${key} is required when PROVISIONING_ENABLED=true`,
					path: [key],
				});
			}
		}
	})
	.transform(({ PROVISIONING_ENABLED, WORKER_ENABLED, ...config }) => ({
		...config,
		provisioningEnabled: PROVISIONING_ENABLED === "true",
		workerEnabled: WORKER_ENABLED === "true",
	}));

// ControllerConfig is the validated runtime configuration for the controller.
export type ControllerConfig = z.output<typeof envSchema>;

// controllerConfig validates controller configuration before infrastructure work begins.
export function controllerConfig(
	env: Record<string, string | undefined>,
): ControllerConfig {
	return envSchema.parse(env);
}
