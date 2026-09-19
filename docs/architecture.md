# Architecture

Describes the system as built. Where an earlier intention was abandoned, the reason is stated
rather than the intention quietly removed.

## What a workspace is

A request for work, not a request for a container.

You supply a repository, a ref, and a purpose. The controller builds a disposable Proxmox LXC,
checks the repository out into it, starts a Claude Code agent inside it, and gives that agent the
purpose verbatim. The container is an implementation detail of that.

One agent per workspace. An earlier plan had several; nothing needed them, and one agent per
container keeps the ownership, credential, and teardown stories simple.

## The interface, and two reversals

The original architecture said the web UI should provide "fleet-level visibility" and "should not
attempt to reproduce interactive terminal sessions", with interactive work happening in a Herdr
client. **The first reversal** made the detail page the primary interface: the controller already
had to read the agent's screen to know whether it was usable, and once a browser can see a screen,
requiring a second tool to type into it is friction rather than separation.

**The second reversal removed the screen.** The agent ran as a TUI in a Herdr pane; the controller
read a rendered viewport every two seconds, inferred what the agent was doing from a status string,
and answered permission dialogs by typing `1` into the pane. That was the only mechanism available
to something reading a pane from outside.

There is a real one. Under the Agent SDK's `query()`, a tool call that no rule resolves falls
through to a **`canUseTool` callback** — async, so it can wait for a person, and able to deny with
a message the model reads and works around. Conversation history arrives as typed SDK messages.

So the centre column is a conversation rather than a terminal emulator, and approving a tool is a
decision with a visible subject rather than a keystroke aimed at a box of text.

**Herdr is gone.** Its pane was the only thing it was still providing, and the Terminal tab was
already a plain `ssh -tt` rather than a Herdr session. `docs/herdr-integration.md` records what it
taught us and why it left.

## Planes

**Provisioning.** The controller owns the infrastructure lifecycle: clone, boot, address, reach,
bootstrap, check out, destroy. It holds a pool-scoped Proxmox token. Nothing else does.

**Agent control.** A runner process inside each workspace holds one Claude Code Agent SDK session
open and listens on a unix socket. The controller reaches it with `ssh -- nc -U`. See "The agent
runner" below.

**Human interface.** A dashboard: a sidebar of workspaces, the agent's conversation with a prompt
below it, and a tabbed rail holding placement, the diff, the timeline and a shell.

## Provisioning

A single durable operation advances one phase per pass, resuming from the database rather than
from memory, so a controller that stops mid-clone picks up where it left off.

```text
requested → clone-submitted → clone-confirmed → start-submitted → booted
          → addressed → reachable → bootstrapped → checked-out
          → runner-started → briefed
```

Three phases became one when Herdr went. Starting a server, creating a workspace in it, and
starting an agent in a pane were three round trips with three distinct failure vocabularies
(`agent_name_taken`, `agent_not_ready`, `agent_prompt_stalled`) and a first-run wizard check on the
end. A process either listens on its socket or it does not.

`ready` means briefed and working, not merely built.

Each phase is one Proxmox call or one SSH round trip.

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

The detail page's rail is tabbed. **Details** is placement. **Diff** is every changed file as one
page, each row collapsed, unfolding its diff in place.

This shape arrived third. The first replaced the whole rail with the file you opened, so reading a
change cost you sight of everything else. The second gave each opened file a **tab of its own**,
which fixed that and cost a click, a tab switch and a sideways-scrolling tab strip per file. The
accordion is what a change set actually is: one list, read top to bottom, opened where you care.

Flat rather than a tree, which is why `@pierre/trees` is no longer a dependency. The set is what
one agent touched, usually a handful of files, and a full path already says where each one lives.
The tree also virtualised against its own host box and rendered into shadow DOM, so it could not
host a diff underneath a row — the whole feature.

Each row fetches when it is unfolded and unmounts when it is folded. A read is an SSH round trip,
so fetching every file to show a page of shut rows would open a connection per changed file; and
the diff renderer carries a syntax highlighter, so several left mounted and hidden is several
highlight passes' worth of DOM behind rows nobody has open.

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

## The agent runner

A detached node process inside each workspace, holding one Agent SDK `query()` open for the life of
the container and listening on a unix socket.

**Reached over SSH with `nc -U`, not on a port.** A TCP listener would put an unauthenticated
"drive this agent" endpoint on the workspace network and need its own authentication to close
again. A socket reached over ssh inherits the key that already gates everything else.

**Detached, not held by the controller.** A deploy restarts the controller, and an agent whose
session lived in the controller's memory would lose its turn every time somebody shipped a change.
`setsid` is what makes that true; the credentials are sourced explicitly in the same script,
because `~/.config/agent-env` is hooked into `.bashrc` and a detached non-interactive process never
reads it. Without that line the runner starts, listens, accepts prompts, and answers every one with
"Not logged in".

**Shipped by the controller, with only the SDK in the template.** The logic changes often and a
template rebuild is a VMID swap; the dependency changes rarely and weighs about 245 MB. Containers
are linked clones of one ZFS snapshot, so the template pays that once for the whole fleet. The
runner finds the SDK through a `node_modules` symlink to the global root — `NODE_PATH` is a
CommonJS mechanism and node's ESM resolver ignores it.

**Attaching replays.** The snapshot carries the whole transcript and every parked approval, because
a controller that restarts leaves approvals waiting inside a runner that is still alive, and a
reader that only subscribed would show an idle agent that is actually waiting for an answer.

**The transcript is not mirrored into the database.** It is replayed on attach. The cost, stated:
destroying a workspace destroys its transcript. That was already true of the screen, and the
timeline still records prompts, pushes and discards, so the record of what was *decided* survives.

**Permissions default to `auto`** — a second model reviewing each action rather than a person —
and the mode is configurable. Confirmed working on the subscription token. When auto mode is not
available to a session, Claude Code silently runs Manual instead, which degrades safely here
because every call then reaches the approval UI.

## A shell in the workspace

The rail's **Terminal** tab opens an interactive shell in the container, over a WebSocket on the
controller's own http server.

This was previously listed as deliberately not built, on the grounds that a rendered viewport is
not a byte stream, so a terminal emulator would be the wrong shape "until there is real keystroke
input". There is now real keystroke input, so the condition the note set has been met rather than
ignored.

**A shell of its own, not the agent's session.** Poking about with `git log` must not put
keystrokes into a session an agent is working in. The centre column is the agent's conversation;
this is a separate login.

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
  unnecessary, and then Herdr itself went.
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
