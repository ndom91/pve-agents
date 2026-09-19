import type { QueryClient } from "@tanstack/react-query";
import {
	createRootRouteWithContext,
	HeadContent,
	Scripts,
} from "@tanstack/react-router";

import appCss from "../styles.css?url";

// The query client reaches loaders through route context, so a loader can prime the cache instead
// of fetching alongside it.
export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()(
	{
		head: () => ({
			meta: [
				{
					charSet: "utf-8",
				},
				{
					name: "viewport",
					content: "width=device-width, initial-scale=1",
				},
				{
					title: "Agent Compute Controller",
				},
				{
					rel: "apple-touch-icon",
					sizes: "180x180",
					href: "/apple-touch-icon.png",
				},
				{
					rel: "icon",
					type: "image/svg",
					href: "/icon0.svg",
				},
				{
					rel: "icon",
					type: "image/png",
					sizes: "96x96",
					href: "/icon1.png",
				},
				{ rel: "manifest", href: "/manifest.json", color: "#fffff" },
				{ rel: "icon", href: "/favicon.ico" },
			],
			links: [
				{
					rel: "stylesheet",
					href: appCss,
				},
			],
		}),
		shellComponent: RootDocument,
	},
);

function RootDocument({ children }: { children: React.ReactNode }) {
	return (
		<html lang="en">
			<head>
				<HeadContent />
			</head>
			<body>
				{children}

				<Scripts />
			</body>
		</html>
	);
}
