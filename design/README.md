# pve-agents design handoff

Drop this whole folder into the repo at `design/` and commit it. It is the
input for the UI refresh.

```
design/
├── STYLE.md            ← read this first; the spec
├── tokens.css          ← CSS custom properties, land this before anything else
├── mockups/            ← self-contained HTML, every value inline. The real spec.
│   ├── workspace.html      agent / chat page
│   ├── home.html           launch screen
│   ├── foundations.html    palette, type scale, control set
│   ├── tab-details.html
│   ├── tab-diff.html
│   ├── tab-timeline.html
│   └── tab-terminal.html
└── screenshots/        ← PNGs of the above, for eyeballing and for pasting into chat
```

Open any file in `mockups/` directly in a browser — no build step, no server.

## Kickoff prompt for Claude Code

Paste this, adjusting the paths:

> We're doing a visual refresh of the pve-agents frontend. The spec is in
> `design/STYLE.md`, the tokens are in `design/tokens.css`, and
> `design/mockups/*.html` are self-contained reference mockups with every value
> inline — treat the HTML as the source of truth and the PNGs in
> `design/screenshots/` as a sanity check only.
>
> Read `design/STYLE.md` fully before writing any code. This is a refresh, not a
> redesign: same screens, same information, same flows.
>
> Start with step 1 in §8 — land `tokens.css` as its own commit, imported
> globally, with no visual change. Then stop and show me the diff.
>
> After that we'll work through §8 one surface at a time. For each one: open the
> matching mockup, copy the exact paddings, sizes, letter-spacing and colors, and
> replace hexes with the matching `var(--token)`. If a color has no token, add
> one to `tokens.css` rather than inlining it. Don't round anything to a 4/8px
> grid. Don't ship the placeholder data listed in §0.

## Why not just screenshots

Screenshots lose every number. An agent reading a PNG has to guess that a label
is 9.5px at 0.16em tracking in `#7d8b76`, and it will guess 12px, no tracking,
`#888`. The HTML carries all of it exactly, and the agent can open it, diff its
own output against it, and screenshot it itself. Keep the PNGs around for
pointing at things in conversation — that's what they're good for.

## One caveat on fonts

The mockups load JetBrains Mono and Geist from Google Fonts as metric stand-ins,
because the repo wasn't reachable from the machine these were built on. Keep
whichever faces the app already ships and point `--font-mono` / `--font-sans` at
them. The sizes, tracking and the mono-vs-sans role split in STYLE.md §3 are the
parts that matter.
