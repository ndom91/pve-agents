import { QueryClient } from "@tanstack/react-query";
import { createRouter as createTanStackRouter } from "@tanstack/react-router";
import { routerWithQueryClient } from "@tanstack/react-router-with-query";

import { routeTree } from "./routeTree.gen";

export function getRouter() {
	// Retries are off because every query here calls a server function that already distinguishes
	// a real failure from a transient one and returns it as data. Retrying on top of that turns one
	// reported problem into three silent attempts and a delayed message.
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: {
				refetchOnWindowFocus: false,
				retry: false,
				// The fleet moves on a worker tick, not on a page load, so data is stale almost
				// immediately. Cadence is set per query instead of globally.
				staleTime: 0,
			},
		},
	});

	const router = createTanStackRouter({
		context: { queryClient },
		defaultPreload: "intent",
		defaultPreloadStaleTime: 0,
		routeTree,
		scrollRestoration: true,
	});

	// Supplies the QueryClientProvider, puts the client in route context for loaders, and
	// dehydrates the cache across the SSR boundary so a first paint is not refetched on hydration.
	return routerWithQueryClient(router, queryClient);
}

declare module "@tanstack/react-router" {
	interface Register {
		router: ReturnType<typeof getRouter>;
	}
}
