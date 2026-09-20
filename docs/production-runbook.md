# Production Runbook

## Preflight

1. Run `pnpm check`, `pnpm typecheck`, `pnpm test`, and `pnpm build` from a clean checkout.
2. Create a dedicated service account and a writable persistent directory, for example `/var/lib/pve-agents`.
3. Put controller configuration in a root-readable environment file. Do not put Proxmox token secrets in the repository. Every `pnpm` entrypoint also loads a local `.env` through Node's `--env-file-if-exists`, which is for development only; `.env` is gitignored and a missing one is not an error. In production the systemd `EnvironmentFile` supplies the same variables. See `.env.example` for the full set.
4. Bind the service only to localhost or a trusted LAN address. Put TLS at the reverse proxy before exposing the API beyond the controller host.
5. Set `CONTROLLER_AUTH_SECRET` to at least 32 random characters and `CONTROLLER_URL` to the address the controller is reached on. Configuration validation refuses to start with `PROVISIONING_ENABLED=true` unless the secret is set.
6. Create a GitHub OAuth app with callback `<CONTROLLER_URL>/api/auth/callback/github` and scope `user:email`. Set `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and `CONTROLLER_OPERATOR_GITHUB_ID` (the numeric account id, from `curl -s https://api.github.com/users/<login> | jq .id`). That id is the only account the controller will ever admit.
7. Mint an API key with `pnpm apikey:create <name>` for CLI and automation callers. It is printed once and stored only as a hash; there is no way to read it back.
8. Leave `PROVISIONING_ENABLED=false` until the Proxmox template, pool, network, and token permissions have been verified against disposable infrastructure.

Every route accepts either an operator session cookie (browser, via GitHub sign-in) or an `x-api-key` header (CLI, automation). Reads are guarded too, including `GET /api/infrastructure/probe`.

`CONTROLLER_URL` must exactly match the origin the browser uses. better-auth derives cookie and CSRF behaviour from it, so a mismatch produces sign-ins that appear to succeed and then have no session.

Two migration systems share the database: the controller's own versioned runner and better-auth's, which owns the `user`, `session`, `account`, `verification`, and `apikey` tables.

Run `pnpm db:migrate` after deploying new code and before starting the service. Both systems are idempotent — running it repeatedly applies only what is missing — so it is safe in any deploy script.

The controller's migrations also run when the database is first opened, but that happens lazily on the first request that touches it. A deploy that skips `db:migrate` therefore reports itself healthy while still on the old schema, and a failing migration surfaces as a broken request rather than a failed deploy.

## systemd

`pnpm start` runs the Node HTTP adapter around TanStack Start's Fetch handler. Use a unit equivalent to:

```ini
[Unit]
Description=PVE Agents Controller
After=network.target

[Service]
Type=simple
User=pve-agents
WorkingDirectory=/opt/pve-agents
EnvironmentFile=/opt/pve-agents/.env
ExecStart=/usr/bin/pnpm start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Set `DATABASE_PATH=/var/lib/pve-agents/controller.db` in `/opt/pve-agents/.env`, owned by the service account and `0640`. One file, not two: a second copy under `/etc` existed briefly and was removed, because two sources of configuration is one more than can be kept in agreement.

`NODE_EXTRA_CA_CERTS` is the one setting that cannot live there. Node reads it before `--env-file` is processed, so the systemd unit sets it directly and `bin/controller-node.sh` exports it for commands run by hand. Set `CONTROLLER_HOST` and `CONTROLLER_PORT` there; the listener defaults to `127.0.0.1:3000`.

## Operation

1. Check `GET /api/health`. It reports whether provisioning is enabled and whether auth is configured, and never returns key or secret material.
2. Advance workspace operations with `pnpm worker:tick` for a single pass, or `pnpm worker:tick --watch <seconds>` to poll. Set `WORKER_ENABLED=true` to run the same loop inside the server process on `WORKER_INTERVAL_SECONDS` (default 5). It is off by default so the first real clone and destroy are stepped by hand with Proxmox inspected between passes. Ticks never overlap: each pass is awaited before the next is scheduled.
3. Back up the SQLite database while the service is stopped, or use SQLite's online backup support. Keep the `-wal` and `-shm` sidecar files consistent with the main database when using file-level backups. The database now also holds better-auth's tables, so a restore rolls back issued API keys too.
4. Review queued operation records before upgrading a future executor release. Queued operations are intentionally preserved across restarts.
5. A destroy request cancels any outstanding provision operation for that workspace, so teardown cannot race a clone.
6. A destroy that halts leaves the workspace in `destroying` with `error_code` set and `error_retryable=0`. `destroy_ownership_mismatch` means a container did not carry this controller's ownership marker and was deliberately left untouched; investigate by hand before retrying.
7. Do not set `PROVISIONING_ENABLED=true` until the Proxmox template, pool, network, token permissions, and ownership-marker workflow have been verified against disposable infrastructure.


## Repository access

The controller clones as a GitHub App, not with a personal token. Create the App with **Contents:
read and write** and **Pull requests: read and write**, no webhook, installable on your account
only. Generate a private key, copy it to the controller at `0600` owned by the service account, and
set `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, and `GITHUB_APP_PRIVATE_KEY_PATH`.

The installation id is the number at the end of the URL after installing.

These are distinct from `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`, which are the OAuth app
operators sign in with. Different credential, different purpose, easy to confuse.

Tokens are minted per workspace, scoped to that one repository, and last an hour. A request naming
a repository the App cannot see is refused immediately rather than failing at checkout, because
minting a scoped token is itself the access check.

## Agent credentials

`WORKSPACE_CLAUDE_OAUTH_TOKEN` comes from `claude setup-token`, which needs a browser and a Claude
subscription. It is not an API key. Rotating it is an edit and a restart; nothing is baked into the
template, so no clone carries it.

## VMID range

Set `PROXMOX_VMID_MIN` to keep disposable workspaces in their own band, away from hand-built
guests. Proxmox has no "next free id at or above N", so the controller probes candidates with
`/cluster/nextid?vmid=N`, which is cluster-wide even under a pool-scoped token. The scan is bounded
to 128 candidates above the floor.

## Reaping

Off until switched on, and configured from the **settings page** rather than the environment: these
are read on every pass, so a change applies without a restart.

An idle timeout, a maximum age, and a grace period for failed workspaces. Three things are exempt
from destruction — a blocked agent, a workspace holding uncommitted or unpushed work, and one the
controller cannot inspect — so a container can be kept alive indefinitely by any of them. The UI
marks those, and the timeline records why each reap was declined.

## Orphaned containers

The settings page has a scan for containers this controller created and no longer has a record of.
It runs only when asked. **Nothing about orphans runs on a timer**, because a restored or lost
database makes every live workspace look orphaned and anything automatic would then destroy the
fleet. Destroying one re-verifies the ownership marker server-side first.

## Reverse proxy

The detail page streams over server-sent events, and Caddy buffers by default in two places. The
proxy needs `flush_interval -1`, and the stream path must be excluded from compression:

```caddyfile
reverse_proxy 127.0.0.1:3000 {
	flush_interval -1
}

@compressible not path /api/workspaces/*/stream /api/workspaces/*/agent
encode @compressible gzip
```

`encode` rejects `not` in a response matcher, which is why the exclusion is a named request matcher
on the path. This works perfectly against the port directly and fails only behind the proxy, so
test at the real hostname.

**Every streaming path must be listed here, and the failure when one is not is silent.** The agent
stream was added and forgotten: the request returned 200, the connection stayed open, and not one
byte arrived, because gzip was buffering a stream that never fills a buffer. Nothing in any log
said so. If a new stream appears to connect and never delivers, look here first.

## Deploying an update

```sh
./bin/deploy.sh              # deploy
./bin/deploy.sh --dry-run    # show what would be sent and removed, change nothing
```

**Use the script rather than the steps.** This procedure has been reconstructed from memory more
than once, and each reconstruction dropped a different step. None of the omissions failed loudly;
they were found later, by someone wondering why the box was in a state nobody had chosen.

Overridable with `DEPLOY_HOST` and `DEPLOY_ROOT`, which is also how you would deploy a second one.

### The steps that look optional and are not

**`rm -rf node_modules` before installing.** The deploy ends with `pnpm prune --prod`. A later
`pnpm install --frozen-lockfile` then reports "Already up to date" and does **not** restore
devDependencies, so the next build fails on a missing Vite.

**Removing `node_modules` also removes pnpm's shims**, so use `corepack pnpm` rather than `pnpm`
from that point on, or the very next line is `pnpm: command not found`.

**`rsync --delete`, over the whole tree.** Syncing a list of paths leaves behind files deleted or
renamed in the repository. A stale module that still resolves is an hour of debugging.

**`rsync --no-owner --no-group`.** Plain `-a` carries the *developer machine's* uid across, so the
controller's code ends up owned by a number that means nothing there. The `chown` at the end used
to be what corrected this, which meant every deploy fought itself and a failure between the two
steps left the wrong answer in place. Not sending ownership removes the race; the `chown` stays as
the thing that states the intended result rather than repairs an unintended one.

**`chown -R root:pve-agents`.** The service user must be able to read its code and must not
own it.

**Migrate before starting, not after.** The controller applies migrations lazily, on the first
request that touches the database. Skip this and it reports itself healthy on the old schema and
surfaces the failure as a broken request rather than a failed deploy.

**Stop the service before syncing.** Otherwise the tree is replaced under a running process.

### Open the site afterwards

`check`, `typecheck`, `test` and `build` do not load a page. All four have passed against a build
whose client bundle threw during hydration and rendered nothing but an error box. The script cannot
catch this; a person has to look. Anything touching `src/router.tsx`, routing or SSR especially.

### Dependencies are pinned exactly

Because the deploy deletes `node_modules` every time, a floating version specifier means a deploy
can install something other than what last worked, with nothing in the diff to show for it.

`@tanstack/react-router` and `@tanstack/react-start` were once `"latest"`. A fresh install
eventually paired them with `@tanstack/react-router-with-query`, which had stopped at 1.130 while
the router went on to 1.170 and still declared a peer range of `">=1.43.2"`. It called an API the
router no longer had, hydration threw, and the whole UI was an error box. **Treat a wide peer range
as no guarantee at all.**

### Shutdown

The controller stops in well under a second, with pages open. It used to take the full 90 seconds
and end in a `SIGKILL`, because `server.close()` waits for open connections to finish and a
server-sent events stream never finishes. `closeAllConnections()` is what ends them. The watcher
poll and the stream keepalive are unreferenced timers, so a background loop is never the last thing
holding the process alive.

A five-second fallback calls `process.exit` if something still does. If you see
`controller did not exit cleanly, forcing` in the journal, something new is holding the event loop
and is worth finding rather than living with.
