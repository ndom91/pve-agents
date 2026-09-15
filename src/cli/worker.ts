import {
	controllerDatabase,
	controllerRuntimeConfig,
} from "../server/controller";
import { runWorkspaceOperations } from "../services/workspace-operation-worker";

// The worker has no timer and no HTTP trigger on purpose. Until the lifecycle has been proven
// against real infrastructure, an operator steps it by hand and inspects Proxmox between passes.
async function main(): Promise<void> {
	const watch = watchInterval(process.argv.slice(2));
	const db = controllerDatabase();
	const config = controllerRuntimeConfig();

	if (watch === undefined) {
		await tick(db, config);

		return;
	}

	console.log(`watching for workspace operations every ${watch}s`);
	for (;;) {
		await tick(db, config);
		await new Promise((resolve) => setTimeout(resolve, watch * 1_000));
	}
}

async function tick(
	db: ReturnType<typeof controllerDatabase>,
	config: ReturnType<typeof controllerRuntimeConfig>,
): Promise<void> {
	const run = await runWorkspaceOperations(db, config);
	if (run.processed === 0 && run.status === "empty") {
		return;
	}

	console.log(`${new Date().toISOString()} ${run.status}`);
}

function watchInterval(args: string[]): number | undefined {
	const index = args.indexOf("--watch");
	if (index === -1) {
		return undefined;
	}

	const seconds = Number.parseInt(args[index + 1] ?? "5", 10);
	if (!Number.isInteger(seconds) || seconds < 1) {
		throw new Error("--watch requires a positive number of seconds");
	}

	return seconds;
}

main().catch((error) => {
	console.error("worker failed", error);
	process.exitCode = 1;
});
