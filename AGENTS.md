# Working on this repository

A controller that provisions disposable Proxmox LXC containers as coding-agent workspaces. It runs
on LXC 108, behind Caddy at `https://pve-agents.puff.lan`.

Read `docs/architecture.md` first. It describes the system as built, including the places where an
earlier intention was abandoned and why.

## Deploying

```sh
./bin/deploy.sh              # deploy
./bin/deploy.sh --dry-run    # show what would be sent and removed, change nothing
```

**Do not deploy by hand.** The controller's checkout is not a git repository; it is an rsync target.
The procedure has several steps whose omission fails silently and is discovered much later, so it
lives in the script. `docs/production-runbook.md` explains which steps look optional and are not.

## Verifying

```sh
pnpm check && pnpm typecheck && pnpm test && pnpm build
```

All four, before committing. `deploy.sh` runs them again and refuses to ship if any fails.

**None of them load a page.** There are no hydration tests, so all four can pass against a build
whose client bundle throws on load and renders nothing but an error box. That has happened. After
deploying anything that touches `src/router.tsx`, routing, or SSR, open the site and look at it.

**Dependencies are pinned to exact versions on purpose.** `@tanstack/react-router` and
`@tanstack/react-start` were once `"latest"`, which meant a fresh `pnpm install` could resolve
something different from what was last known to work, and the deploy deletes `node_modules` every
time. Keep them exact, and treat a wide peer range as no guarantee at all: the package that broke
hydration declared `@tanstack/react-router: ">=1.43.2"` while being incompatible with everything
past 1.130.

## Server functions

A `*.functions.ts` module exports server functions **and nothing else**. Each handler is one line
that calls an operation in a plain module beside it, such as `agent-operations.ts`.

**Exporting anything else from that file breaks the client build silently.** The route it belongs
to renders from the server and then sits inert: no console error, no failed request, no hydration
warning, every button dead. Anything exported beside a server function has to survive the plugin's
client transform, and an ordinary function that touches SQLite or SSH cannot.

Tests target the operations module. A server function itself cannot be called from a test: it
reads its options from an AsyncLocalStorage the Start runtime owns, and the callable a test imports
is the client-side RPC stub, because the transform that makes it a direct call only runs for the
server build. Testing the operation is testing the work; the wrapper is a validator and a
middleware line, visible in one screenful.

## Things this codebase has already learned

**`ssh` does not preserve argv boundaries.** It joins the command and the remote shell splits it
again, so an argument containing a space becomes two and one containing a semicolon is remote code
execution under the controller's key. Everything goes through `quoteRemote` in `src/services/ssh.ts`.
Remote scripts are fixed strings with values supplied *positionally* (`sh -c SCRIPT sh "$1" "$2"`),
never interpolated.

**Secrets travel on stdin, never as arguments.** Arguments are visible in `ps` on the workspace for
as long as the command runs. `runSsh` takes an optional `input` for this.

**"Could not tell" is never "safe to destroy".** The reaper is the only path that loses something
irreversibly. A workspace it cannot inspect is kept. This rule is why `UnsavedWork` has an
`unknown` variant distinct from `clean`, and the distinction must survive any refactor of it.

**Destructive actions re-read the ownership marker immediately beforehand.** An LXC description
carrying `managed-by`, `controller-id` and an ownership token is the *only* thing authorising a
destroy. Pool membership, hostname and tags are discovery aids, not authorisation.

**A command that exits 0 has not necessarily done anything.** Learned twice, which is why it is
here rather than in a comment. A tool once accepted a working directory that did not exist,
reported success, and left a shell sitting in the wrong place with nothing in any log to say so.
The runner caught us the same way: the script that launches it backgrounds the process and exits,
so "launched" cannot mean "running". `startRunner` deliberately returns a type that cannot answer
that question, and the caller polls the socket instead.

**A state you infer from somebody else's classification is a state you cannot fix.** Claude
Code's TUI had three first-run gates and the tool watching it labelled them inconsistently, so
neither the status nor the screen text alone detected all three and the controller had to read
both. The SDK has no such gates and the detection is gone, but `claudeSeed` in
`src/services/claude-agent.ts` still writes the settings that skip them — see the comment there
for why removing that unverified is not worth what it risks.

**Settings that get tuned against a running fleet live in the database, not `.env`.** `.env` holds
what the controller *is*; the database holds what it *does*. See "Configuration versus policy" in
the architecture doc.

## Conventions

Comments explain **why**, and name the gotcha. A comment restating the code is worse than none.
Several comments here record a wrong assumption that cost real time; leave those in place.

Commit messages say what changed and what it was for, in prose. Tests carry the same burden: a test
name should say which rule it protects, not which function it calls.

### Interface

**Appearance is a `variant`, never a class you pass in.** `Button`, `IconButton` and `Select` take
`primary` | `secondary` | `tertiary`. `className` on those components is for layout only — where a
control sits, never how it looks. A new quiet button that arrives as its own class is how the CSS
grew three near-identical rules the last time.

**Never style focus per control.** `styles.css` sets one ring on the bare `:focus-visible`, which
reaches everything including whatever gets added next. This started as a list of selectors and was
wrong twice: each time, a control nobody remembered kept the platform's bright blue ring, which on
this palette is the loudest thing on the page. If a control needs something other than the ring, it
*overrides* it — `.rail-resizer` and the code editor's textarea both do, and both say why.

A `<select>` needs `appearance: none` before any of that works. Left at the platform default it
keeps a system border and a system focus ring that no amount of `outline` reliably replaces.

**Controls that sit in a row share `--field-height`.** A select, a text field and a button beside
each other were 36, 34 and 36 pixels tall, which does not read as a size choice.
