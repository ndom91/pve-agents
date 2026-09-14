import { z } from "zod";

const envSchema = z.object({
	DATABASE_PATH: z.string().min(1).default("./data/controller.db"),
	HOST: z.string().min(1).default("127.0.0.1"),
	PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
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
});

// ControllerConfig is the validated runtime configuration for the controller.
export type ControllerConfig = z.output<typeof envSchema>;

// controllerConfig validates controller configuration before infrastructure work begins.
export function controllerConfig(
	env: Record<string, string | undefined>,
): ControllerConfig {
	return envSchema.parse(env);
}
