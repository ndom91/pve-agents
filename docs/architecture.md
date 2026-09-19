# Architecture

Describes the system as built. Where an earlier intention was abandoned, the reason is stated
rather than the intention quietly removed.

## What a workspace is

A request for work, not a request for a container.

You supply a repository, a ref, and a purpose. The controller builds a disposable Proxmox LXC,
checks the repository out into it, starts a Claude Code agent inside a Herdr session, and gives
that agent the purpose verbatim. The container is an implementation detail of that.

One agent per workspace. An earlier plan had several; nothing needed them, and one agent per
container keeps the ownership, credential, and teardown stories simple.

## The interface, and a reversal

The original architecture said the web UI should provide "fleet-level visibility" and "should not
attempt to reproduce interactive terminal sessions", with interactive work happening in a Herdr
client.

**That is no longer true, deliberately.** The detail page streams the agent's terminal, sends
prompts, and answers permission dialogs. The reversal happened because the controller already had
to read the agent's screen to know whether it was usable, and once a browser can see the screen,
requiring a second tool to type into it is friction rather than separation.

Herdr remains the source of truth for terminal state inside a workspace. The web UI is now the
primary way a person interacts with it.

## Planes

**Provisioning.** The controller owns the infrastructure lifecycle: clone, boot, address, reach,
bootstrap, check out, destroy. It holds a pool-scoped Proxmox token. Nothing else does.

**Agent control.** Herdr 0.9.0 scopes its CLI and socket API to one server, so all agent operations
run the Herdr CLI on the target workspace over SSH. There is no remote Herdr API.

**Human interface.** A dashboard: a sidebar of workspaces, the agent's live screen with a prompt
below it, and a tabbed rail holding placement, the diff, the timeline and a shell.

## Provisioning

A single durable operation advances one phase per pass, resuming from the database rather than
from memory, so a controller that stops mid-clone picks up where it left off.

```text
requested → clone-submitted → clone-confirmed → start-submitted → booted
          → addressed → reachable → bootstrapped → checked-out
          → session-started → herdr-registered → agent-started → briefed
```

`ready` means briefed and working, not merely built.

Each phase is one Proxmox call or one SSH round trip. Several are less obvious than they look and
`docs/herdr-integration.md` records why.

## Ownership

Every container carries a marker in its LXC description: the software name, the controller's id,
the workspace id, and an ownership token, written atomically during the clone.

**That description is the only thing that authorises destruction.** Pool membership, hostname and
tags are discovery aids. Nothing is deleted without re-reading the marker immediately beforehand —
including an orphan the operator clicked, because a VMID arriving in a form is a request rather
than authorisation.

## The scheduler

One loop, four passes in order, each awaited so they cannot overlap:

1. **Operations** — drains several queued lifecycle steps, bounded by count and elapsed time.
   Claimed by when an operation is next due, not when it was created; ordering by creation starved
   every request behind the first.
2. **Activity** — reads what each ready agent is doing, at most every 30 seconds.
3. **Credentials** — replaces git credentials before their hour is up.
4. **Reaping** — destroys workspaces that have outlived their usefulness, if switched on.

Activity runs before reaping deliberately: reaping decides on the activity it records.

## What the controller refuses to destroy

Reaping is the only path that can lose something irreversibly, so it declines in three cases:

- **A blocked agent**, which is waiting for a person. Exempt from both the idle limit and the
  maximum age.
- **Unsaved work** — uncommitted changes, or commits never pushed. Also exempt from both, because
  exempting from idle alone would only postpone the loss to the cap.
- **A workspace it cannot inspect.** "Could not tell" is not "nothing to lose".

The cost is that a stray untracked file keeps a container alive indefinitely. The UI marks those
workspaces, because the trade is only acceptable if it is visible.

## Seeing and keeping the work

The detail page's rail is tabbed. **Details** is placement. **Diff** is a tree of what the agent
changed. Opening a file from that tree gives it a **tab of its own**, closable, several at a time,
so reading one change does not cost you the one you were reading before — and never costs you sight
of the terminal, which is what an earlier version did.

The rail is draggable from its left edge, because a diff wants more width than a sidebar has, and
the width is remembered. It is bounded so it cannot be pulled over the terminal.

Read as two file contents rather than as a patch. `git diff` says nothing at all about an untracked
file, and an agent creating one is both the commonest change and the one that most often holds a
workspace back from reaping, so a patch-shaped answer would have shown that case as nothing.

Two things can be done with it:

- **Push** commits everything and sends it to `herdr/<hostname>`, never the checked-out ref.
  Unreviewed agent output must not reach `main` because somebody clicked quickly, and a side branch
  is what makes the button safe enough to need no confirmation. A confirmation people learn to
  dismiss protects nothing.
- **Discard** resets the working tree, behind a confirmation naming the files it will destroy and
  armed against that exact set. Commits survive it, so a workspace holding unpushed commits stays
  held afterwards. Destroying commits is not something a button should do.

Both re-read the tree afterwards, so the reaping protection releases at once rather than at the next
pass, and both count as interaction.

This is also what closes the loop the protection opened. Before it, a held workspace was held until
somebody opened a terminal.

## A shell in the workspace

The rail's **Terminal** tab opens an interactive shell in the container, over a WebSocket on the
controller's own http server.

This was previously listed as deliberately not built, on the grounds that `--source visible`
returns a rendered viewport rather than a byte stream, so a terminal emulator would be the wrong
shape "until there is real keystroke input". There is now real keystroke input, so the condition
the note set has been met rather than ignored.

**A fresh session, not the agent's pane.** Reading what an agent is doing and typing into the
session it is working in are different things, and only the first is safe to offer beside a "run
git log" prompt. The centre column still shows the agent's own screen.

**`ssh -tt` rather than a pty library.** The remote side allocates the tty, so there is no native
module to build and nothing new on the workspace template. The cost is that the channel carries no
`SIGWINCH`: the size is set once, in the remote command before the shell starts, and a browser
resize does not follow it. Sending it afterwards would type `stty` at the operator's own prompt.

`TERM` is set explicitly, because ssh forwards whatever it finds locally and the controller runs as
a service with none. Without it every paged command stops at "terminal is not fully functional".

**Authentication is the operator session**, through the same `authorizeRequest` every other
endpoint uses. That function allows everything when `CONTROLLER_AUTH_SECRET` is unset, so an
unconfigured controller hands out a shell on the same terms it hands out every page. It is a shell
rather than a page, which is the reason to set the secret.

## Freshness

Three reads at three cadences, which is a ratio rather than three arbitrary numbers:

- The fleet list polls the database every 2.5s while anything can still change.
- The activity pass reads each ready agent every 30s.
- An open detail page streams its workspace over server-sent events, reading every 2s.

The stream **writes what it observes to the database**, so the record everything else reads is
fresh to about two seconds while a page is open. It previously pushed only to the browser, where
the 2.5s database poll overwrote it with a 30-second-old value, and the controls for answering a
dialog — gated on that value — were unusable as a result.

Server-sent events rather than a socket: every write is request-and-answer and already works as a
server function. A socket becomes right when there is keystroke-level input to stream upward.

## Credentials

| What | Where it lives | Reaches a workspace as |
|---|---|---|
| Proxmox API token | `.env` | never leaves the controller |
| GitHub App key | file on disk, `0600` | a repo-scoped token, renewed hourly |
| Claude subscription token | `.env` | a file the pane's shell sources |

Both workspace credentials arrive **on stdin**, never as arguments, so neither appears in the
process list. Git reads its credential from a store rather than a URL, because git repeats the
remote it was using in its errors and those reach the timeline the UI renders.

`ssh` does not preserve argument boundaries — it joins the command and the remote shell re-splits
it — so everything sent is quoted before it leaves.

## Configuration versus policy

`.env` holds what the controller **is**: its Proxmox token, its GitHub App, where its key lives.
Changing those is a deployment change and a restart is the natural moment.

The database holds what it **does**: whether reaping is on and its thresholds. Those get tuned
against a running fleet, so they are read on every pass and take effect without a restart. That is
the entire reason they moved.

## Deliberately not built

- **An organiser agent**, and registering the controller as a Herdr machine. The web UI made both
  unnecessary.
- **A database backup.** Judged low value: the containers outlive the database and the orphan scan
  finds them, so what is lost is history rather than access.
- **Automatic orphan destruction.** A restored or lost database makes every live workspace look
  orphaned, and a timer would then purge the fleet. It is a scan and a click.
- **Opening a pull request.** The GitHub App has the permission, but a PR wants a title and a body
  that would have to be invented or demanded, and a branch is enough to review from.
- **Editing files from the browser.** `@pierre/diffs` would support it. It is a different feature.
- **Tests that call a server function.** A server function reads its options from an
  AsyncLocalStorage the Start runtime owns, and the callable a test imports is the client-side RPC
  stub, so one cannot be invoked from a test at all. Its three properties are checked the ways that
  remain: the method off the stub, and the operator guard and the validator out of the source.
  What that cannot reach is whether a schema is the *right* schema — only that input is validated
  exactly when there is input. The one schema rule that would matter if it were wrong, refusing a
  path that climbs out of the checkout, is enforced in `workspace-changes.ts` and tested there,
  which is the right place for it: it protects every caller rather than one endpoint.
