import { builtinModules } from "node:module";

import { defineConfig } from "vite";

// The CLI entrypoints are built separately from the TanStack Start server bundle so that operator
// tooling shares the controller's TypeScript sources rather than reimplementing configuration,
// database, and auth wiring in plain JavaScript where the two could silently drift apart.
const config = defineConfig({
	build: {
		emptyOutDir: true,
		lib: {
			entry: {
				apikey: "src/cli/apikey.ts",
				config: "src/cli/config.ts",
				scheduler: "src/cli/scheduler.ts",
				worker: "src/cli/worker.ts",
			},
			formats: ["es"],
		},
		outDir: "dist/cli",
		rollupOptions: {
			external: [
				/^node:/,
				...builtinModules,
				/^better-auth/,
				/^@better-auth\//,
				"better-sqlite3",
			],
		},
		ssr: true,
		target: "node22",
	},
	resolve: { tsconfigPaths: true },
});

export default config;
