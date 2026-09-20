import { useEffect } from "react";

// The icon the badge is drawn over, and the square it is drawn in.
//
// icon1.png rather than icon0.svg: the SVG is 808KB of wrapped raster and would be fetched in
// full to produce a 16px tab icon. 64 is four times what a tab shows, which is what a retina
// display asks for and small enough that the data URL stays short.
const SOURCE = "/icon1.png";
const SIZE = 64;

// A saturated red rather than the palette's --danger, which is a border colour chosen to sit
// quietly inside a dark page. This has to survive being scaled to sixteen pixels and noticed in
// the corner of somebody's eye while they are reading something else.
const BADGE = "#f2494f";

// The ring is the page's own background, so the badge reads as sitting on top of the icon rather
// than as part of its artwork. Without it the red merges into the icon's own edge at tab size.
const RING = "#111411";

// useFaviconAlert marks the tab's icon while an agent is waiting for an answer.
//
// The title already carries a count, and a count in a title is invisible to somebody whose tab
// strip is showing sixteen tabs and no text. The icon is the only part of a background tab that
// is always drawn.
export function useFaviconAlert(waiting: boolean): void {
	useEffect(() => {
		if (typeof document === "undefined") {
			return;
		}

		const icons = [
			...document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]'),
		];
		if (icons.length === 0) {
			return;
		}

		// The hrefs are put back rather than the elements being replaced. These links belong to
		// the router's head, and removing nodes it rendered invites it to render them again
		// underneath us; setting an attribute it may later reset degrades to no badge, which is
		// the failure worth having.
		const original = icons.map((icon) => icon.href);
		const restore = (): void => {
			icons.forEach((icon, index) => {
				const href = original[index];
				if (href !== undefined) {
					icon.href = href;
				}
			});
		};

		if (!waiting) {
			restore();
			return;
		}

		let stale = false;
		const image = new Image();
		image.src = SOURCE;
		image.onload = () => {
			if (stale) {
				return;
			}

			const badged = draw(image);
			if (badged === undefined) {
				return;
			}

			for (const icon of icons) {
				icon.href = badged;
			}
		};

		// Restored on the way out as well as when nothing is waiting: a page navigated away from
		// mid-alert would otherwise leave the marked icon behind in the browser's cache for the
		// tab, and it would still be there after the question had been answered.
		return () => {
			stale = true;
			restore();
		};
	}, [waiting]);
}

// draw paints the icon with an exclamation mark in its bottom-right corner.
//
// Returns undefined where there is no 2D context to draw into, which is a headless environment
// rather than a browser that cannot manage it.
function draw(image: HTMLImageElement): string | undefined {
	const canvas = document.createElement("canvas");
	canvas.width = SIZE;
	canvas.height = SIZE;

	const paint = canvas.getContext("2d");
	if (paint === null) {
		return undefined;
	}

	paint.drawImage(image, 0, 0, SIZE, SIZE);

	// Big enough to be a shape rather than a speck once the browser has scaled all of this down
	// to sixteen pixels. It covers a corner of the icon, which is the price of being seen.
	const centre = SIZE - 20;
	const radius = 19;

	paint.beginPath();
	paint.arc(centre, centre, radius, 0, Math.PI * 2);
	paint.fillStyle = BADGE;
	paint.fill();
	paint.lineWidth = 4;
	paint.strokeStyle = RING;
	paint.stroke();

	// The mark is drawn rather than typed. Text at this size renders differently on every
	// platform and a glyph hinted for a paragraph is not a glyph that survives a 4:1 downscale.
	paint.fillStyle = "#ffffff";
	paint.beginPath();
	paint.roundRect(centre - 2.6, centre - 11, 5.2, 13, 2.6);
	paint.fill();
	paint.beginPath();
	paint.arc(centre, centre + 7.5, 3, 0, Math.PI * 2);
	paint.fill();

	return canvas.toDataURL("image/png");
}
