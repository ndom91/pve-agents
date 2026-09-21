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
					title: "Proxmox Agents",
				},
				// Matches the page background, so the browser chrome on a phone does not frame a
				// dark application in white -- or, since light mode, a light one in near-black.
				// Two metas keyed on the OS preference rather than one: this is chrome outside the
				// document and it cannot read data-theme, so it follows the same signal the boot
				// script falls back to.
				{
					content: "#111411",
					media: "(prefers-color-scheme: dark)",
					name: "theme-color",
				},
				{
					content: "#fbfcf9",
					media: "(prefers-color-scheme: light)",
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
				// public/icon0.svg is deliberately not referenced. It is 808KB, because it is a
				// 1254px raster wrapped in an SVG rather than real vector art, and a browser
				// offered an SVG icon tends to prefer it over every sized raster — so a 16px
				// favicon would cost most of a megabyte on a cold load. It stays in public/ for
				// use inside the app, where its size buys something.
				//
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

// THEME_BOOT sets data-theme before the browser paints anything.
//
// Inline in the head, not in the bundle, and that is the whole point: a theme applied by React runs
// after first paint, so somebody who chose dark gets a white page for a frame on every single load.
// Inline, the attribute is on <html> before any pixel of <body> exists.
//
// A stored choice wins; with none, follow the OS. Wrapped in try/catch because reading
// localStorage throws outright in some privacy modes, and a throw here would take the document
// with it before anything had rendered.
export const THEME_BOOT = `try{var t=localStorage.getItem('pve-agents.theme');if(t!=='light'&&t!=='dark'){t=matchMedia('(prefers-color-scheme: light)').matches?'light':'dark'}document.documentElement.dataset.theme=t}catch(e){document.documentElement.dataset.theme='dark'}`;

function RootDocument({ children }: { children: React.ReactNode }) {
	return (
		// `dark` as the served default, so the markup the server sends already says what it is and
		// the script below only has to change it for the minority who chose otherwise.
		//
		// `suppressHydrationWarning` because the script deliberately mutates this attribute before
		// React hydrates -- which is the whole point of it running inline. Without this React
		// compares the two and warns on every light-mode load about the one attribute the entire
		// stylesheet hangs off.
		<html data-theme="dark" lang="en" suppressHydrationWarning>
			<head>
				{/* Before HeadContent, so it runs before the stylesheet link is even parsed. */}
				{/* biome-ignore lint/security/noDangerouslySetInnerHtml: a fixed string with no interpolation, and it has to be inline to beat first paint */}
				<script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
				<HeadContent />
			</head>
			<body>
				{children}

				<Scripts />
			</body>
		</html>
	);
}
