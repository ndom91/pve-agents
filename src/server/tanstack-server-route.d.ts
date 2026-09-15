// biome-ignore-all lint/complexity/noBannedTypes: must exactly mirror TanStack's declaration.
// biome-ignore-all lint/suspicious/noExplicitAny: must exactly mirror TanStack's declaration.
import type { AnyContext, AnyRoute } from "@tanstack/router-core";

declare module "@tanstack/router-core" {
	interface FilebaseRouteOptionsInterface<
		TRegister,
		TParentRoute extends AnyRoute = AnyRoute,
		TId extends string = string,
		TPath extends string = string,
		TSearchValidator = undefined,
		TParams = {},
		TLoaderDeps extends Record<string, any> = {},
		TLoaderFn = undefined,
		TRouterContext = {},
		TRouteContextFn = AnyContext,
		TBeforeLoadFn = AnyContext,
		TRemountDepsFn = AnyContext,
		TSSR = unknown,
		TServerMiddlewares = unknown,
		THandlers = undefined,
	> {
		server?: {
			handlers: Record<string, (context: any) => Response | Promise<Response>>;
		};
	}
}
