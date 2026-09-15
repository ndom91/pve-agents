# PVE Herdr Agents

LAN controller for requesting disposable agent workspaces. It persists workspace intent and lifecycle operations in SQLite, but it does not create, modify, or destroy Proxmox resources yet.

## Local Development

```bash
pnpm install
pnpm dev
```

Controller state defaults to `./data/controller.db`. Copy `.env.example` to `.env` to choose another path or prepare Proxmox settings. The database directory is intentionally ignored by Git.

Run all local checks with:

```bash
pnpm check
pnpm typecheck
pnpm test
pnpm build
```

## Safety Boundary

`PROVISIONING_ENABLED=false` is the default. Requests create durable queued operations only; the operation executor performs no infrastructure work.

Setting `PROVISIONING_ENABLED=true` requires all Proxmox settings in `.env.example`, but still does not enable Proxmox actions until a reviewed Proxmox adapter is added. Keep the controller bound to a trusted LAN or localhost and place authentication in front of the HTTP API before enabling any destructive executor.

## HTTP API

- `GET /api/health` reports controller health and provisioning state.
- `GET /api/workspaces` lists workspace requests.
- `POST /api/workspaces` creates a workspace request. Include `idempotencyKey`, `repository`, and optional `ref` and `purpose` in the JSON body.
- `GET /api/workspaces/:workspaceId` gets one workspace.
- `DELETE /api/workspaces/:workspaceId` queues destruction without performing it.
- `POST /api/workspaces/:workspaceId/retry` queues a retry only for a failed workspace.

See `docs/production-runbook.md` before deploying it as a long-running controller.
