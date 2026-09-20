<img src="public/web-app-manifest-192x192.png" width="88" alt="">

# PVE Agents

A controller that turns a request for work into a disposable Proxmox LXC with a coding agent
already working in it.

You give it a repository, a ref, and a purpose. It clones a golden template, boots the container,
checks the repository out, starts a Claude Code agent inside it, and hands it the
purpose. The web UI then streams that agent's terminal, takes prompts, answers its permission
dialogs, shows what it changed, and pushes or discards the result. When the workspace has outlived
its usefulness, the controller destroys it — unless it is holding work nobody has kept.

Built for one operator on a trusted LAN. It holds a Proxmox token, a GitHub App key, and a Claude
subscription token, and it creates and destroys real containers.

## Documentation

| | |
|---|---|
| [`AGENTS.md`](AGENTS.md) | Start here to work on the code. Conventions, and the rules this codebase learned the hard way. |
| [`docs/architecture.md`](docs/architecture.md) | The system as built, including where an earlier intention was abandoned and why. |
| [`docs/production-runbook.md`](docs/production-runbook.md) | Deploying and operating it. |
| [`docs/proxmox-lifecycle.md`](docs/proxmox-lifecycle.md) | Clone, boot, address, destroy, and reconcile. |
| [`docs/herdr-integration.md`](docs/herdr-integration.md) | Why Herdr left, and the two lessons that outlived it. |
| [`docs/security-and-networking.md`](docs/security-and-networking.md) | Network shape, credentials, and what is deliberately not trusted. |

## Running it locally

```bash
pnpm install
pnpm dev
```

State lives in `./data/controller.db` by default. Copy `.env.example` to `.env` to change that or
to configure Proxmox. The listener defaults to `127.0.0.1:3000`; `CONTROLLER_HOST` and
`CONTROLLER_PORT` change it.

Before committing:

```bash
pnpm check && pnpm typecheck && pnpm test && pnpm build
```

None of those load a page. After anything touching routing or SSR, open the site and look at it.

## Deploying

```bash
./bin/deploy.sh              # deploy
./bin/deploy.sh --dry-run    # show what would be sent and removed, change nothing
```

Not by hand: the controller's checkout is an rsync target rather than a git clone, and several
steps fail silently if skipped. `docs/production-runbook.md` explains which.

## What creates containers

`PROVISIONING_ENABLED` gates every Proxmox write. With it off, requests queue durable operations
and nothing is built; with it on, the controller clones, boots and destroys for real.

Destruction is the only path that loses something irreversibly, so it is the one with the most
said about it:

- **Only the ownership marker authorises it.** Every container carries the controller's id, the
  workspace id, and a token in its LXC description, re-read immediately before anything is purged.
  Pool membership, hostname and tags are discovery aids, not permission.
- **Unsaved work is kept.** Uncommitted changes or unpushed commits exempt a workspace from
  reaping, as does a workspace the controller could not inspect. "Could not tell" is not "nothing
  to lose".
- **Unrecognised containers are reported, never destroyed.** A restored or lost database makes
  every live workspace look orphaned, and a timer would then purge the fleet.

## Authentication

**Off unless configured.** Setting `CONTROLLER_AUTH_SECRET` is what turns it on: with it, the UI
is behind a GitHub sign-in and the API expects a key. Without it, the controller answers anyone who
can reach it, which is only survivable because it is meant to sit on a trusted LAN. Set it.

## HTTP API

Everything the UI does goes through server functions rather than these. They exist for scripting.

| | |
|---|---|
| `GET /api/health` | Controller health and whether provisioning is on. |
| `GET /api/workspaces` | List workspaces. |
| `POST /api/workspaces` | Request one. Takes `idempotencyKey`, `repository`, and optional `ref` and `purpose`. |
| `GET /api/workspaces/:id` | One workspace and its timeline. |
| `DELETE /api/workspaces/:id` | Queue destruction. |
| `POST /api/workspaces/:id/retry` | Queue a retry, for a failed workspace only. |
| `GET /api/workspaces/:id/stream` | Server-sent events: the agent's screen and what it is doing. |
| `GET /api/infrastructure/probe` | Check the controller can reach Proxmox. |
