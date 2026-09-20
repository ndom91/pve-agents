# Herdr, and why it left

Herdr is no longer part of this system. This file is kept rather than deleted because the
repository was named after it until it became `pve-agents`, because two of its lessons outlived
it, and because the name is still all over this project's history.

## What it did

Herdr 0.9.0 gave a workspace a terminal multiplexer with a structured CLI: a server per named
session, workspaces and panes inside it, and agents attached to panes with lifecycle states. The
controller ran that CLI on each workspace over SSH.

Claude Code ran as a TUI in a pane. The controller read a rendered viewport every two seconds,
inferred what the agent was doing from `agent_status`, and answered permission dialogs by sending
keystrokes — literally `1`, or `enter`, aimed at a box of text.

That was not a poor choice. It was the only mechanism available to something reading a pane from
outside, and it worked: a workspace went from request to a briefed, working agent in about a
minute, unattended, against real hardware.

## Why it went

The Agent SDK offers the things the pane was standing in for:

- **`canUseTool`**, an async callback a tool call genuinely suspends inside. It can wait for a
  person for hours and it can deny with a message the model reads and works around. Answering names
  the request rather than aiming a keystroke at whatever happens to be on screen.
- **Typed messages** instead of a rendered viewport, so a conversation can be rendered as one.

Once the agent was driven that way, Herdr had nothing left to do. The Terminal tab was already a
plain `ssh -tt` rather than a Herdr session, so the pane served only the agent, and the agent no
longer wanted one. Three provisioning phases and three failure vocabularies
(`agent_name_taken`, `agent_not_ready`, `agent_prompt_stalled`) went with it.

## The two lessons that outlived it

**`ssh` does not preserve argument boundaries.** The client joins the command it is given with
spaces and hands the result to the remote login shell, which splits it again and interprets every
metacharacter. An array of arguments is not an array by the time it arrives.

Everything the controller sends is therefore quoted by `quoteRemote` in `src/services/ssh.ts`.
Without it, a label containing a space becomes two arguments, and one containing a semicolon runs
as a second command under the controller's key. A fixed script with data supplied *positionally* is
the safe shape, because the script text never varies:

```bash
sh -c 'printf %s "$2" > "$HOME/.claude.json"' sh <cwd> <json>
```

**A command that exits 0 has not necessarily done anything.** Herdr's `workspace create` ignored a
`--cwd` that did not exist: exit 0, `workspace_created`, and a pane in the home directory with no
repository in it and nothing in any log to explain it. The controller had to create the directory
first and then verify the echoed path.

The same shape caught us again with the runner, which is why it is worth writing down twice: the
script that launches it backgrounds the process and exits 0, so "launched" cannot mean "running".
`startRunner` returns a type that cannot answer that question, and the caller polls the socket.

## Also recorded, because it explains a comment

Claude Code's TUI had three first-run gates — a theme picker, a per-directory trust dialog, and
login — and Herdr classified them inconsistently: the trust dialog as `blocked`, the theme picker
as `idle` with `interactive_ready: true` and `agent start` exiting 0. Neither the status nor the
pane text alone detected both, so the controller read both.

The SDK has no such gates, so the detection is gone. `claudeSeed` in
`src/services/claude-agent.ts` still writes the settings that skip them, deliberately — see the
comment there for why an unverified removal is not worth the risk it carries.

Its other discovery still holds: an agent's own output was **not** readable through `agent read`,
because Claude Code draws on the terminal's alternate screen and those rows never enter Herdr's
scrollback. That limitation is a large part of why the SDK's message stream was worth moving to.
