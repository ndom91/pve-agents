# pve-agents — visual style guide

A design refresh of the existing app. **Not a redesign**: same screens, same
information, same flows. What changes is hierarchy, density, surface depth and
the consistency of the small parts.

Read this file, then open the mockups in `mockups/` — they are self-contained
HTML with every value inline, so they are the precise spec. The PNGs in
`screenshots/` are for eyeballing only; when a number is in question, read the
HTML, not the picture.

---

## 0. How to use this (read first if you are an agent)

1. Land `tokens.css` first, as its own change. Import it once, globally.
2. Then convert **one surface at a time**, in the order in §8. Do not attempt
   the whole app in one pass.
3. For each surface: open the matching file in `mockups/`, find the element you
   are building, and copy the actual numbers — padding, font-size,
   letter-spacing, border color. Do not round them to a 4/8px grid and do not
   substitute a framework default.
4. Replace hardcoded hexes with the `var(--token)` that matches. If a color in
   the mockup has no token, that is a bug in `tokens.css` — add the token, do
   not inline the hex.
5. The mockups are static. Hover, focus, loading, empty and error states are
   specified in §5 and §6 in words — implement them from there.

**Where the mockups have placeholder data** (Linear ticket titles, destroyed
workspace names, diff contents, `+128 −24` counts, "1 of 8" capacity) — that is
filler to make the layout legible. Wire real data; do not ship the strings.

---

## 1. The ten rules

1. **Four surfaces, not one.** The app currently paints `#111411` everywhere.
   Wells recede (`--surface-well`), the page sits at `--surface-base`, chrome
   sinks slightly (`--surface-sunk`), content groups lift
   (`--surface-raised`).
2. **Monospace is for machine facts only** — ids, paths, addresses, branches,
   states, durations, timestamps, counts, log lines, code. Anything a human or
   the agent *wrote* is sans. The current app monospaces everything, which is
   why nothing stands out.
3. **Labels are uppercase mono, 9.5px, `0.16em`, `--text-muted`.** Values sit
   directly under or beside them at 11.5px. This pair is the single most
   repeated unit in the app — get it right once.
4. **Sage is action, green is truth.** `--sage` fills the one primary button on
   a surface. `--green` means something is live/ready/healthy right now.
   Destroy is never sage — it is a red-outlined button or icon.
5. **One primary action per surface.** Home: request workspace. Workspace page:
   send. Everything else is secondary or ghost.
6. **A section header is a label + a hairline that runs to the edge.** Not a
   bold heading, not a box. It is the app's main structural device.
7. **Numbers are tabular.** `font-variant-numeric: tabular-nums` on every
   duration, timestamp, size, count and address, so columns stop twitching as
   values tick.
8. **Groups get a border; rows inside a group get a hairline.**
   `--line-border` wraps, `--line-inner` divides. Never both on the same edge.
9. **Flat.** No gradients, no glow, no backdrop blur, no shadow larger than a
   1px border. Depth comes from the surface ramp, full stop.
10. **No emoji as UI. No icon fonts.** Inline stroke SVG at 9–13px,
    `currentColor`, `stroke-width` 1.1–1.3.

---

## 2. Tokens

See `tokens.css`. Do not read hex values out of this document — read them from
there, it is the source of truth. The groups are: surfaces, lines, ink, signal,
type, radius, space, layout, motion.

Two notes:

- **Contrast.** The current label grey `#485145` measures ~4.3:1 on the app
  background and fails AA for small text. `--text-muted` (`#7d8b76`) is 5.1:1
  and is the floor for anything that is words. `--text-decorative` is below the
  floor on purpose and is only ever used for dots, rails and gutter numbers.
- **Fonts.** The mockups load JetBrains Mono and Geist as *metric stand-ins*.
  Keep whichever faces the app already ships — only the role split, sizes and
  letter-spacing in §3 are prescriptive. Point `--font-mono` and `--font-sans`
  at the real ones.

---

## 3. Type

| Role | Family | Size | Tracking | Color |
| --- | --- | --- | --- | --- |
| Section label | mono, uppercase | 9.5px | 0.16em | `--text-muted` |
| Key name (in a key/value row) | mono, uppercase | 9.5px | 0.10em | `--text-dim` |
| Tab / button label | mono, uppercase | 10–10.5px | 0.12–0.14em | per component |
| Machine value | mono | 11.5px | — | `--text-body` |
| Dense machine value (log rows, meta band) | mono | 10.5px | — | `--text-secondary` |
| Terminal / diff body | mono | 10–10.5px | — | see §6 |
| Feed prose | sans | 13.5px / 1.6 | — | `--text-body` |
| List row | sans | 12.5px | — | `--text-body` |
| Screen title (top bar) | sans 500 | 14px | — | `--text-primary` |
| Page title (home) | sans 500 | 22px | −0.01em | `--text-primary` |

Bold is 500 or 600 only, and only on mono labels and titles. Never bold body
prose; use `--text-primary` against `--text-body` for emphasis instead.

---

## 4. Layout shell

```
┌────────────┬──────────────────────────────────┬──────────────┐
│ sidebar    │ top bar            48px          │ tab bar 48px │
│ 236px      ├──────────────────────────────────┤──────────────┤
│            │ meta band          32px          │              │
│ surface-   ├──────────────────────────────────┤ panel 392px  │
│ sunk       │                                  │ surface-sunk │
│            │ feed        surface-base         │              │
│            │                                  │              │
│            ├──────────────────────────────────┤              │
│            │ composer                         │              │
└────────────┴──────────────────────────────────┴──────────────┘
```

- Sidebar and right panel are `--surface-sunk` with a 1px `--line-hairline`
  edge toward the center. The center column is `--surface-base`. That one
  change does most of the work of making the app feel built.
- The **meta band** (32px, `--surface-sunk`, mono facts separated by 1px ×
  11px dividers) is the refresh's signature element. It appears on both the
  home screen (controller status) and the workspace page (placement). It is
  where every machine fact that used to fight the content now lives.
- Right panel: 392px inside the app shell. The tab mockups are drawn at 400px
  because they carry their own left border.
- The workspace page should hold up between roughly 1100px and 1800px wide.
  Below ~1100px, collapse the right panel behind a toggle; the tab bar becomes
  the toggle's menu. Not designed yet — ask before inventing it.

---

## 5. Interaction states

These apply to every interactive element unless a component below overrides.

- **Hover**: the surface steps up one level (`--surface-raised` →
  `--surface-hover`); a transparent control gains `--surface-raised`. Text
  color does not change. `transition: background var(--dur-fast) var(--ease)`.
- **Active / pressed**: one more step up. No transform, no scale.
- **Focus**: a 2px ring in `--focus-ring`, offset 2px from the control, and
  never removed. On a destructive control the ring is `--red-line-strong`.
  Drawn with `outline` and `outline-offset`. The rule used to say "never an
  `outline`", which was aimed at the browser's default blue and is not the
  constraint it was: an offset outline gives the same ring, follows the border
  radius, and does not repaint on scroll the way a `box-shadow` does.
- **Selected row**: `--surface-select` plus a 2px inset bar of `--sage` on the
  left edge. The bar replaces the focus ring while selected.
- **Disabled**: keep opacity at 1. Drop the surface to `--surface-base` and the
  text to `--text-faint`; `cursor: not-allowed`.
- **Live**: a 5–6px `--green` dot with
  `box-shadow: 0 0 0 3px rgba(127,160,106,0.16)`. Used for running workspaces,
  the ready state, the attached terminal. If you animate it, it is a slow
  opacity pulse on the ring only — never the dot, never a scale.
- **Loading**: no spinners in chrome. A pending row shows a `--text-decorative`
  dot and its duration column reads `—`. A provisioning workspace uses the
  lifecycle strip (§6) with filled segments up to the current step.

---

## 6. Components

Copy the exact markup from `mockups/`; the CSS below is the normalized version
to build against.

### Section header
The structural unit. Label, then a hairline to the right edge, optionally a
count or status on the far right.

```css
.section-head { display: flex; align-items: center; gap: 9px; }
.section-head__label {
  font: var(--text-label)/1 var(--font-mono);
  letter-spacing: var(--tracking-label);
  text-transform: uppercase;
  color: var(--text-muted);
}
.section-head__rule { flex-grow: 1; height: 1px; background: var(--line-hairline); }
```
Seen in: right panel (source / placement / progress / identity), home
(running / recently destroyed / new workspace).

### Key/value row
Two shapes. **Inline** (label 86–88px fixed, value fills) when values are
short strings; **stacked** (label above value) inside a 2- or 3-up grid when
values are numeric or the panel is narrow.

```css
.kv { display: flex; align-items: baseline; gap: 12px; }
.kv__key {
  width: 88px; flex-shrink: 0;
  font: var(--text-label)/1 var(--font-mono);
  letter-spacing: 0.10em; text-transform: uppercase;
  color: var(--text-dim);
}
.kv__val {
  flex-grow: 1;
  font: var(--text-mono)/1.3 var(--font-mono);
  color: var(--text-body);
  font-variant-numeric: tabular-nums;
}
```

### Meta band
```css
.meta-band {
  height: var(--metaband-h); padding: 0 var(--space-8);
  display: flex; align-items: center; gap: var(--space-6);
  background: var(--surface-sunk);
  border-bottom: 1px solid var(--line-hairline);
}
.meta-band__item { display: flex; align-items: center; gap: 6px; }
.meta-band__key {
  font: var(--text-label)/1 var(--font-mono);
  letter-spacing: 0.14em; color: #626e5d;
}
.meta-band__val {
  font: var(--text-mono-sm)/1 var(--font-mono);
  color: var(--text-secondary); font-variant-numeric: tabular-nums;
}
.meta-band__sep { width: 1px; height: 11px; background: var(--line-border); }
```
Last item in the band is pushed right (`flex-grow: 1` spacer) and is the
"how long / how many" summary.

### Buttons
Three variants plus ghost icon. Height 26px in a bar, 30px standalone, 32px as
a form's primary.

```css
.btn { /* shared */
  display: inline-flex; align-items: center; justify-content: center; gap: 7px;
  border-radius: var(--radius-md); cursor: pointer;
  font: 600 var(--text-label-lg)/1 var(--font-mono);
  letter-spacing: var(--tracking-ui); text-transform: uppercase;
  transition: background var(--dur-fast) var(--ease);
}
.btn--primary { background: var(--sage); color: var(--sage-ink); border: 0; }
.btn--secondary {
  background: transparent; border: 1px solid var(--line-border);
  color: #c9d6c2; font-weight: 400;
}
.btn--danger {
  background: transparent; border: 1px solid var(--red-line);
  color: var(--red); font-weight: 400;
}
.btn--icon { width: 26px; padding: 0; } /* always needs aria-label */
```
**Destroy is `--danger`, never primary.** In the current app it is the
accent-filled button, which makes the most destructive action the most
attractive thing on the screen.

### Segmented control (wanted state)
Replaces the loose `READY` / `IDLE` buttons. One bordered group, 1px internal
divider, active segment filled `--sage-quiet` with a `--green` dot.

```css
.segmented { display: flex; border: 1px solid var(--line-border);
  border-radius: var(--radius-md); overflow: hidden; }
.segmented__item { height: var(--control-h); padding: 0 12px;
  display: flex; align-items: center; gap: 6px;
  font: var(--text-label)/1 var(--font-mono);
  letter-spacing: var(--tracking-ui); color: var(--text-muted); }
.segmented__item[aria-pressed="true"] { background: var(--sage-quiet); color: #dbe8d2; }
.segmented__div { width: 1px; background: var(--line-border); }
```
Implement as `<button aria-pressed>` in a `role="group"` with an accessible
group label ("Wanted state").

### Status chip
21px tall, dot + label, tinted fill + tinted border. Four kinds: green (ready),
amber (provisioning), neutral (idle), red (error). Values in `tokens.css` under
`--chip-*`. Chips are for *state*; they are never buttons.

### Lifecycle strip
Six equal segments with 3px gaps, `--radius-xs`, filled `--green` up to the
current step and `--line-hairline` beyond. Maps to requested → cloned → booted
→ reachable → seeded → ready. Appears on the home table row, the right panel's
progress section, and the workspace sidebar item. It is the one place a
provisioning container communicates progress at a glance.

### Tool-call log group
The biggest change to the feed. A bordered group at `--surface-sunk` with a
27px header strip (`TOOL CALLS · n`, error count, total duration), then one row
per call: chevron, status dot, mono name, `DONE`/`ERROR`, right-aligned
duration in a fixed 40px column. Rows divided by `--line-inner`. An errored row
gets `--surface-raised`, red text, and expands to a `--surface-well` box with
`--red-well-line` border underneath. Collapsed by default when the group has no
errors; expanded to the failing row when it does.

### Composer
`--surface-well`, 1px `--line-border`, `--radius-lg`, 12px padding. Input on
top, a footer row of keyboard hints (`--text-faint`) with the primary SEND
button pushed right. Keyboard hints use real glyphs (⌘↵, ⇧↵, ⌃C), never images.

### Feed turns
- **User turn**: a `›` in `--sage` in a 10px gutter, the text in
  `--text-primary` at 13.5px, timestamp below in 9.5px mono `--text-faint`.
- **Agent prose**: indented 22px to align under the user text, 13.5px/1.6
  `--text-body`. No avatar, no name repeated per message.
- **Turn separator**: a single 1px `--line-hairline` between exchanges.

### Diff rows
Line number gutter 46px right-aligned `--diff-gutter`, 12px sign column, then
content. Added rows `--diff-add-bg` + `--diff-add-text`; removed
`--diff-del-bg` + `--diff-del-text`; context transparent with
`--text-secondary`. Hunk headers are a full-width `#12160f` strip. File list
above uses A/M/D single-letter markers in green/amber/red.

### Terminal
`--surface-well`, mono 10px/1.6, `white-space: pre-wrap; word-break: break-all`
so long `ls -l` lines wrap the way they actually do at 392px. **Terminal output
keeps ANSI colors** — directories blue `#8fb0d6`, symlinks teal `#7fd3c8` —
because recoloring real shell output to the brand palette would misrepresent
what the shell printed. This is the one sanctioned exception to the palette.
Block cursor is a 6×13px `--sage` inline block.

---

## 7. Accessibility

- Real elements: `<button>`, `<a href>`, `<input>` + `<label>`. Never `onClick`
  on a div — the mockups use real elements throughout, keep them.
- Every icon-only button has an `aria-label`. There are ~12 in the app.
- Focus rings are never removed (§5).
- Text at 4.5:1 minimum. `--text-muted` is the floor; anything dimmer is
  decoration and must not carry meaning alone.
- Status is never color-only: every chip and dot is paired with a word
  (`READY`, `ERROR`, `DONE`).
- `prefers-reduced-motion` collapses all three durations to 1ms — already
  handled in `tokens.css`.

---

## 8. Screens, and a suggested order

| # | Mockup | Surface | Notes |
| --- | --- | --- | --- |
| 1 | — | `tokens.css` | Land alone, no visual change. |
| 2 | `mockups/foundations.html` | reference | Not a screen. The ramp, type scale and control set in one place. Useful to diff against while building. |
| 3 | `mockups/workspace.html` | agent page | Top bar, meta band, feed, tool log group, composer, right panel. The biggest win; do it first. |
| 4 | `mockups/tab-details.html` | right panel | Sectioned key/values, copy buttons on ssh + uuid, timestamps in a 2-up grid. |
| 5 | `mockups/tab-timeline.html` | right panel | Rail with elapsed deltas between events; the four events that share `22:41:50` nest as a sub-group instead of repeating the timestamp. |
| 6 | `mockups/tab-terminal.html` | right panel | Path sub-bar with copy/clear/expand, attached state footer. |
| 7 | `mockups/tab-diff.html` | right panel | File list + unified diff. Most new surface area — leave for last. |
| 8 | `mockups/home.html` | home | Running workspaces as a table, controller status into a meta band, launch form in a fixed 392px panel, recently-destroyed below. |

### Specific fixes the mockups encode

- Destroy is no longer the accent-filled primary button.
- `READY` / `IDLE` become one segmented control labelled as wanted state,
  instead of two buttons that look like the two status chips in the sidebar.
- Placement facts (node, vmid, address, branch) leave the right panel's top and
  become the meta band, so they are visible without the panel open.
- The home screen's empty right half is filled by the launch panel; the running
  list becomes a table that still reads with one row.
- Timestamps that were a flat list in the timeline now show the gaps between
  them, which is what you actually want to know.
- Label grey moves from `#485145` to `#7d8b76` for contrast.

---

## 9. Don't

- Don't introduce a fifth surface, a second accent, or a new radius.
- Don't use `--sage` for anything that is not an action.
- Don't monospace prose or sans-serif an id.
- Don't add gradients, glass, glow, drop shadows, or a left-border accent card.
- Don't use Inter/Roboto/Arial as the sans if you are swapping the font.
- Don't round the mockups' numbers to a grid or a framework default.
- Don't ship the placeholder data in §0.
- Don't build the mobile/narrow layout from guesswork — it isn't designed yet.
