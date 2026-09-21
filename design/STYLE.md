# pve-agents — visual style guide

The rules the app is built to. **Not a redesign brief**: this describes what
shipped, and it is what a new surface should be measured against.

Two other things live beside it:

- **`mockups/`** — self-contained HTML with every value inline. When a padding,
  size, tracking or colour is in question, read the HTML. It is frozen at the
  refresh and does not cover light mode, the settings tab or anything added
  since, but the numbers it does carry are exact.
- **`src/tokens.css`** — the tokens themselves, and the only copy. Read hexes
  from there, never from this document.

Where the mockups show placeholder data — Linear ticket titles, invented
workspace names, diff contents, `+128 −24` counts, "1 of 8" capacity — it is
filler to make the layout legible, and none of it ships.

---

## 1. The ten rules

1. **Four surfaces, not one.** Wells recede (`--surface-well`), the page sits at
   `--surface-base`, chrome sinks slightly (`--surface-sunk`), content groups
   lift (`--surface-raised`). One flat colour everywhere is what this replaced.
2. **Monospace is for machine facts only** — ids, paths, addresses, branches,
   states, durations, timestamps, counts, log lines, code. Anything a human or
   the agent *wrote* is sans. Monospace everything and nothing stands out.
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

See `src/tokens.css`. Do not read hex values out of this document — read them
from there, it is the source of truth. The groups are: surfaces, lines, ink,
signal, type, radius, space, layout, motion.

Three notes:

- **Contrast.** `--text-muted` (`#7d8b76`, 5.1:1) is the floor for anything that
  is words. Two tokens sit below it on purpose: `--text-decorative`, which is
  only ever dots, rails and gutter numbers, and `--text-metakey`, which is words
  — the meta band's key, drawn that way in the mockups so the key recedes behind
  the value it labels. `--text-metakey` is for that one job and nothing else;
  four other uses of it were moved to `--text-muted` once they were measured.
- **Fonts.** The mockups load JetBrains Mono and Geist as *metric stand-ins*.
  The app ships its own stacks and `--font-mono` / `--font-sans` point at those.
  Only the role split, sizes and letter-spacing in §3 are prescriptive.
- **Legacy names.** Roughly thirty pre-refresh token names (`--fg-bright`,
  `--border`, `--surface`) are still defined, in both themes, because a handful
  of surfaces were never converted. New work uses the names in this document.

---

## 2a. Themes

Dark is `:root`; light is an override on `[data-theme="light"]`. The attribute
goes on `<html>`, written before first paint by the inline `THEME_BOOT` script in
`src/routes/__root.tsx` — after paint and the page flashes the wrong theme on
every load.

Every token name is defined in **both** blocks, legacy names included. That is
what lets an un-refreshed surface follow the theme without being touched.

One deliberate exception: **the terminal stays dark in light mode**, the way an
editor's integrated terminal does, because its colours belong to the shell rather
than to this application. `.terminal-bar` and `.terminal-overlay` therefore pin
their ink instead of inheriting it — without that, the detached grey and the live
green invert their relative contrast and the LED reads backwards.

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
  11px dividers) is the signature element. It appears on both the home screen
  (controller status) and the workspace page (placement), and it is where every
  machine fact that would otherwise fight the content lives.
- Right panel: 392px inside the app shell. The tab mockups are drawn at 400px
  because they carry their own left border.
- The workspace page should hold up between roughly 1100px and 1800px wide.
  Below ~1100px the panel stacks under the centre column and the page scrolls —
  the pre-refresh behaviour, kept rather than replaced. The collapse-behind-a-
  toggle idea the refresh sketched was never designed past a sentence, so it was
  not built; anything narrower than a laptop is still unspecified.

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
  letter-spacing: 0.14em; color: var(--text-metakey);
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
  color: var(--text-control); font-weight: 400;
}
.btn--danger {
  background: transparent; border: 1px solid var(--red-line);
  color: var(--red); font-weight: 400;
}
.btn--icon { width: 26px; padding: 0; } /* always needs aria-label */
```
**Destroy is `--danger`, never primary.** An accent-filled destroy makes the
most destructive action the most attractive thing on the screen. It ships as a
red-outlined icon button on the workspace page; `Button`'s `danger` variant is
the same treatment for the places that need a word instead of a glyph.

### Status chip
21px tall, dot + label, tinted fill + tinted border. Four kinds: green (ready),
amber (provisioning), neutral (idle), red (error). Values in `src/tokens.css` under
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
`--text-secondary`. Hunk headers are a full-width `--surface-strip` strip. File list
above uses A/M/D single-letter markers in green/amber/red.

### Terminal
`--surface-well`, mono 10px/1.6, `white-space: pre-wrap; word-break: break-all`
so long `ls -l` lines wrap the way they actually do at 392px. **Terminal output
keeps ANSI colors** — directories blue `--ansi-blue`, symlinks teal `--ansi-teal` —
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
  handled in `src/tokens.css`.

---

## 8. The mockups

| File | Covers |
| --- | --- |
| `mockups/foundations.html` | Not a screen. The ramp, type scale and control set in one place — the thing to diff a new control against. |
| `mockups/workspace.html` | Agent page: top bar, meta band, feed, tool log group, composer, right panel. |
| `mockups/tab-details.html` | Sectioned key/values, copy buttons on ssh + uuid, timestamps in a 2-up grid. |
| `mockups/tab-timeline.html` | Rail with elapsed deltas between events; events sharing a second nest instead of repeating the timestamp. |
| `mockups/tab-terminal.html` | Path sub-bar, attached-state footer. |
| `mockups/tab-diff.html` | File list + unified diff. |
| `mockups/home.html` | Running workspaces as a table, controller status as a meta band, launch panel at 392px, recently-destroyed below. |

They are frozen at the refresh. The settings page was never drawn, and nothing
here shows light mode.

---

## 9. Don't

- Don't introduce a second accent or a new radius. Surfaces are the four in §2
  plus `--surface-strip`, which exists for the errored tool row and the diff
  hunk header and is not a licence for a sixth.
- Don't use `--sage` for anything that is not an action.
- Don't monospace prose or sans-serif an id.
- Don't add gradients, glass, glow, drop shadows, or a left-border accent card.
- Don't use Inter/Roboto/Arial as the sans if you are swapping the font.
- Don't round the mockups' numbers to a grid or a framework default.
- Don't ship the mockups' placeholder data.
- Don't build a wanted-state control. The refresh drew `READY`/`IDLE` as one
  segmented toggle; the app has observed `activity` and a `desiredState` that
  only Destroy changes, so the toggle would be a new flow rather than a new
  look. Status chips carry it instead.
- Don't build the mobile/narrow layout from guesswork — below a laptop it still
  isn't designed.
