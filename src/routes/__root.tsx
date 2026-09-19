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
				// Matches the page background, so the browser chrome on a phone does not frame a
				// dark application in white.
				{
					content: "#111411",
					name: "theme-color",
				},
			],
			// Icons and the manifest belong here rather than in `meta`, and the distinction is not
			// pedantic: `meta` renders <meta> elements, and a rel on a <meta> means nothing at all.
			// They rendered, looked plausible in the markup, and no icon was ever loaded.
			links: [
				{
					rel: "stylesheet",
					href: appCss,
				},
				{ href: "/favicon.ico", rel: "icon", sizes: "48x48" },
				{
					href: "/icon1.png",
					rel: "icon",
					sizes: "96x96",
					type: "image/png",
				},
				{
					href: "/icon0.svg",
					rel: "icon",
					type: "image/svg+xml",
				},
				// The file is apple-icon.png. The link pointed at apple-touch-icon.png, which is
				// the conventional name and not the one in this repository, so it 404ed.
				{
					href: "/apple-icon.png",
					rel: "apple-touch-icon",
					sizes: "180x180",
				},
				{ href: "/manifest.json", rel: "manifest" },
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
