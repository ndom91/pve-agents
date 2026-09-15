import { z } from "zod";

const envSchema = z
	.object({
		DATABASE_PATH: z.string().min(1).default("./data/controller.db"),
		PROVISIONING_ENABLED: z.enum(["false", "true"]).default("false"),
		PROXMOX_BRIDGE: z.string().min(1).optional(),
		PROXMOX_NODE: z.string().min(1).optional(),
		PROXMOX_POOL: z.string().min(1).optional(),
		PROXMOX_TEMPLATE_VMID: z.coerce.number().int().min(100).optional(),
		PROXMOX_TOKEN_ID: z.string().min(1).optional(),
		PROXMOX_TOKEN_SECRET: z.string().min(1).optional(),
		PROXMOX_URL: z.url().optional(),
		WORKSPACE_HERDR_SESSION: z.string().min(1).default("agents"),
		WORKSPACE_SSH_KEY_PATH: z.string().min(1).optional(),
		WORKSPACE_SSH_USER: z.string().min(1).default("agent"),
	})
	.superRefine((config, context) => {
		if (config.PROVISIONING_ENABLED === "false") {
			return;
		}

		for (const key of [
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
	.transform(({ PROVISIONING_ENABLED, ...config }) => ({
		...config,
		provisioningEnabled: PROVISIONING_ENABLED === "true",
	}));

// ControllerConfig is the validated runtime configuration for the controller.
export type ControllerConfig = z.output<typeof envSchema>;

// controllerConfig validates controller configuration before infrastructure work begins.
export function controllerConfig(
	env: Record<string, string | undefined>,
): ControllerConfig {
	return envSchema.parse(env);
}
