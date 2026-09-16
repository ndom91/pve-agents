# Production Runbook

## Preflight

1. Run `pnpm check`, `pnpm typecheck`, `pnpm test`, and `pnpm build` from a clean checkout.
2. Create a dedicated service account and a writable persistent directory, for example `/var/lib/pve-herdr-agents`.
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
Description=PVE Herdr Agents Controller
After=network.target

[Service]
Type=simple
User=pve-herdr-agents
WorkingDirectory=/opt/pve-herdr-agents
EnvironmentFile=/etc/pve-herdr-agents/controller.env
ExecStart=/usr/bin/pnpm start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Set `DATABASE_PATH=/var/lib/pve-herdr-agents/controller.db` in `/etc/pve-herdr-agents/controller.env` and ensure the service account owns that directory. Set `CONTROLLER_HOST` and `CONTROLLER_PORT` there; the listener defaults to `127.0.0.1:3000`.

## Operation

1. Check `GET /api/health`. It reports whether provisioning is enabled and whether auth is configured, and never returns key or secret material.
2. Advance workspace operations with `pnpm worker:tick` for a single pass, or `pnpm worker:tick --watch <seconds>` to poll. Set `WORKER_ENABLED=true` to run the same loop inside the server process on `WORKER_INTERVAL_SECONDS` (default 5). It is off by default so the first real clone and destroy are stepped by hand with Proxmox inspected between passes. Ticks never overlap: each pass is awaited before the next is scheduled.
3. Back up the SQLite database while the service is stopped, or use SQLite's online backup support. Keep the `-wal` and `-shm` sidecar files consistent with the main database when using file-level backups. The database now also holds better-auth's tables, so a restore rolls back issued API keys too.
4. Review queued operation records before upgrading a future executor release. Queued operations are intentionally preserved across restarts.
5. A destroy request cancels any outstanding provision operation for that workspace, so teardown cannot race a clone.
6. A destroy that halts leaves the workspace in `destroying` with `error_code` set and `error_retryable=0`. `destroy_ownership_mismatch` means a container did not carry this controller's ownership marker and was deliberately left untouched; investigate by hand before retrying.
7. Do not set `PROVISIONING_ENABLED=true` until the Proxmox template, pool, network, token permissions, and ownership-marker workflow have been verified against disposable infrastructure.
