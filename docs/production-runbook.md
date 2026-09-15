# Production Runbook

## Preflight

1. Run `pnpm check`, `pnpm typecheck`, `pnpm test`, and `pnpm build` from a clean checkout.
2. Create a dedicated service account and a writable persistent directory, for example `/var/lib/pve-herdr-agents`.
3. Put controller configuration in a root-readable environment file. Do not put Proxmox token secrets in the repository.
4. Bind the service only to localhost or a trusted LAN address. Put authentication and TLS at the reverse proxy before exposing the API beyond the controller host.
5. Leave `PROVISIONING_ENABLED=false`. The current release has no Proxmox executor adapter.

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

1. Check `GET /api/health`; it must report `"provisioning":"disabled"` for this release.
2. Back up the SQLite database while the service is stopped, or use SQLite's online backup support. Keep the `-wal` and `-shm` sidecar files consistent with the main database when using file-level backups.
3. Review queued operation records before upgrading a future executor release. Queued operations are intentionally preserved across restarts.
4. Do not set `PROVISIONING_ENABLED=true` until the Proxmox template, pool, network, token permissions, and ownership-marker workflow have been verified against disposable infrastructure.
