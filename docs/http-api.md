# HTTP API

Everything the web UI does goes through server functions rather than these routes. The HTTP API
exists for scripting: requesting a workspace from a CI job, checking the fleet from a terminal,
watching an agent from something that is not a browser.

## Authentication

Send `x-api-key: <key>`. Create a key with:

```bash
pnpm apikey:create
```

**Every route below requires it, except `GET /api/health`.** With `CONTROLLER_AUTH_SECRET` unset
the controller has no authentication at all and answers anyone who can reach it, which is only
survivable on a trusted LAN. `GET /api/health` reports whether auth is configured, so that is the
one call worth making before trusting the rest.

## Routes

| | |
|---|---|
| `GET /api/health` | Controller health, whether auth is configured, and whether provisioning is on. The only unauthenticated route. |
| `GET /api/workspaces` | Every workspace with its timeline. |
| `POST /api/workspaces` | Request one. |
| `GET /api/workspaces/:id` | One workspace, with placement, failure detail and its whole timeline. |
| `DELETE /api/workspaces/:id` | Queue destruction. Returns once the operation is queued, not once the container is gone. |
| `POST /api/workspaces/:id/retry` | Queue a fresh provision. Only for a workspace in `failed`. |
| `GET /api/workspaces/:id/agent` | Server-sent events: the agent's transcript, live. |
| `GET /api/infrastructure/probe` | Check the controller can reach Proxmox. |

## Requesting a workspace

```bash
curl -X POST https://pve-agents.puff.lan/api/workspaces \
  -H "x-api-key: $PVE_AGENTS_KEY" \
  -H "content-type: application/json" \
  -d '{
        "idempotencyKey": "ci-run-8813",
        "repository": "github.com/you/your-repo",
        "ref": "main",
        "purpose": "Work out why the nightly job leaves orphans behind"
      }'
```

| Field | | |
|---|---|---|
| `idempotencyKey` | required | 1-255 chars. Replaying the same key returns the workspace the first call made, rather than building a second container. Replaying it with a *different* body is a conflict, not a new workspace. |
| `repository` | required | 1-2000 chars. |
| `ref` | optional | 1-255 chars, defaults to `main`. |
| `purpose` | optional | 1-500 chars. What the agent is told to do. Without it the workspace comes up ready and idle, waiting for a prompt. |

The response is the persisted workspace. It has been *requested*, not built: the worker picks it up
on its next pass, and the container appears some tens of seconds later. Poll
`GET /api/workspaces/:id` or watch the timeline to see how far it got.

With `PROVISIONING_ENABLED=false` the request is accepted and queued and nothing is ever built.
That is the intended way to exercise this API without touching Proxmox.

## Watching an agent

`GET /api/workspaces/:id/agent` is an `EventSource` stream, not a plain response.

A reader gets the runner's whole snapshot first and the live events after it, because a transcript
replay is not the same for a late arrival as it is for someone who was there from the start. One
SSH attachment is made per reader rather than one shared between them.

The stream sends a comment line every 20 seconds. A thinking agent can say nothing for minutes,
which a proxy or a browser otherwise treats as a dead connection.

**If you put a proxy in front of the controller, exclude this path from buffering and from
compression.** Both hold the stream and deliver it in bursts, or not at all. `deploy/Caddyfile`
shows the two rules that matter.

A workspace with nothing to watch is refused rather than streamed as empty, so a caller can tell
the difference between "no agent here" and "an agent that has not spoken yet".
