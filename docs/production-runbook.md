# Production Runbook

## Preflight

1. Run `pnpm check`, `pnpm typecheck`, `pnpm test`, and `pnpm build` from a clean checkout.
2. Create a dedicated service account and a writable persistent directory, for example `/var/lib/pve-herdr-agents`.
3. Put controller configuration in a root-readable environment file. Do not put Proxmox token secrets in the repository.
4. Bind the service only to localhost or a trusted LAN address. Put TLS at the reverse proxy before exposing the API beyond the controller host.
5. Set `CONTROLLER_AUTH_SECRET` to at least 32 random characters and `CONTROLLER_URL` to the address the controller is reached on. Configuration validation refuses to start with `PROVISIONING_ENABLED=true` unless the secret is set.
6. Mint an API key with `pnpm apikey:create <name>`. It is printed once and stored only as a hash; there is no way to read it back. Mutating routes require it in an `x-api-key` header.
7. Leave `PROVISIONING_ENABLED=false` until the Proxmox template, pool, network, and token permissions have been verified against disposable infrastructure.

Once `CONTROLLER_AUTH_SECRET` is set the web UI is read-only. Workspace creation from the browser is disabled, because a server function cannot carry an API key without publishing it to the browser. Create and destroy workspaces through the HTTP API.

Both schema migrations, the controller's own and better-auth's, run in-process at startup. There is no separate migration command.

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
2. Advance workspace operations with `pnpm worker:tick` for a single pass, or `pnpm worker:tick --watch <seconds>` to poll. There is deliberately no timer and no HTTP trigger: the first real clone and destroy should be stepped by hand with Proxmox inspected between passes.
3. Back up the SQLite database while the service is stopped, or use SQLite's online backup support. Keep the `-wal` and `-shm` sidecar files consistent with the main database when using file-level backups. The database now also holds better-auth's tables, so a restore rolls back issued API keys too.
4. Review queued operation records before upgrading a future executor release. Queued operations are intentionally preserved across restarts.
5. A destroy request cancels any outstanding provision operation for that workspace, so teardown cannot race a clone.
6. A destroy that halts leaves the workspace in `destroying` with `error_code` set and `error_retryable=0`. `destroy_ownership_mismatch` means a container did not carry this controller's ownership marker and was deliberately left untouched; investigate by hand before retrying.
7. Do not set `PROVISIONING_ENABLED=true` until the Proxmox template, pool, network, token permissions, and ownership-marker workflow have been verified against disposable infrastructure.
