import { controllerAuth, issueControllerApiKey } from "../server/auth";
import { controllerRuntimeConfig } from "../server/controller";

async function main(): Promise<void> {
	const config = controllerRuntimeConfig();
	if (config.CONTROLLER_AUTH_SECRET === undefined) {
		throw new Error(
			"CONTROLLER_AUTH_SECRET must be set before issuing an API key",
		);
	}

	const name = process.argv[2] ?? "controller-cli";
	const key = await issueControllerApiKey(await controllerAuth(), name);

	console.log(`api key "${name}" created:`);
	console.log(key);
	// better-auth stores only a hash, and no endpoint returns the plaintext again.
	console.log("Store it now. It cannot be read back.");
}

main().catch((error) => {
	console.error("failed to create api key", error);
	process.exitCode = 1;
});
