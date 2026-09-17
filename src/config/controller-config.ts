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
		GITHUB_CLIENT_ID: z.string().min(1).optional(),
		GITHUB_CLIENT_SECRET: z.string().min(1).optional(),
		PROVISIONING_ENABLED: z.enum(["false", "true"]).default("false"),
		PROXMOX_BRIDGE: z.string().min(1).optional(),
		PROXMOX_NODE: z.string().min(1).optional(),
		PROXMOX_POOL: z.string().min(1).optional(),
		PROXMOX_TEMPLATE_VMID: z.coerce.number().int().min(100).optional(),
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
		// The coding agent started in the workspace's first pane. Must be a kind Herdr recognises,
		// because Herdr refuses to start one it cannot detect afterwards.
		WORKSPACE_AGENT_KIND: z.string().min(1).default("claude"),
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
