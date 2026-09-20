# Seed files

Files the operator uploads once and every new workspace is built with. Editor configuration, a
`CLAUDE.md`, an output style, MCP server definitions — anything that should be true of every
container without being committed to the repository the agent is working in.

Managed from the settings page. Written during provisioning, at the `seeded` phase, which sits
after the checkout and before the runner starts.

## Where a file can go

Each file carries a **root**, and the root is resolved on the container rather than by the
controller — `$HOME` is not knowable from here, and a controller that guessed would be wrong the
day the agent user changes.

| Root | Resolves to | For |
|---|---|---|
| `home` | `$HOME/<path>` | `.gitconfig`, `.claude/settings.json`, an output style |
| `repo` | `/workspace/repo/<path>` | a `CLAUDE.md` the agent should read as part of the checkout |
| `absolute` | `<path>` verbatim | anything outside both, and it has to start with `/` |

`absolute` is not a hole in the validation, and the distinction is the point of having roots at
all. An operator can already open the Terminal tab and write anything as the agent user, so this
is not a privilege boundary. What it prevents is a path that silently escapes the root it claims
— a `home` entry that is really writing to `/etc`. Choosing `absolute` says so out loud.

A destination cannot contain `..` as a path segment, or a newline, or a null byte. The first would
escape its root; the other two would truncate the line the path is written on.

## Limits

256 KB per file, 32 files per workspace. Each file is its own SSH round trip during provisioning,
so the second number is the ceiling on what seeding can cost a workspace that is otherwise ready.

Content is sent on **stdin**, never as an argument. Arguments are visible in `ps` on the workspace
for as long as the command runs, and a seeded file is the one thing here an operator might
reasonably put a credential in.

Seeding stops at the first failure and the step is retried whole, rather than leaving a workspace
with some of its configuration and no way to tell which.

## `~/.claude.json` is merged, not overwritten

One destination is special. `home` + `.claude.json` is **merged** into the file already in the
container rather than replacing it.

It has to be. `bootstrapAgentHome` writes that file two phases earlier, at `reachable`, with the
onboarding and trust-dialog flags that let Claude Code start without a human to answer two
first-run prompts. A seeded copy landing on top would take those flags away and the agent would
stall on a question nobody is there to see.

The merge is deep and the seeded side wins at the leaves: adding `mcpServers` leaves `projects`
alone, and adding one project leaves its siblings alone.

It **refuses rather than repairs**. A file in the container that will not parse fails the step
with a reason, because overwriting it to get the provision moving is exactly how those flags get
lost — surfacing much later as an agent that never answers, instead of here as a step that failed.
The seeded side is validated when you save it, where the operator who typed the trailing comma
still is: it has to be a JSON object, not an array and not a string.

Only at the `home` root. A `.claude.json` in the checkout is an ordinary file.

**Nothing validates key names.** A typo merges in silently and looks right in `cat`, and the
symptom is a feature that is simply absent. `mcpServer` instead of `mcpServers` cost an afternoon.

## Worked example: MCP servers

The problem this solves: the MCP servers worth giving an agent authenticate with OAuth, workspaces
are destroyed several times an hour, and nobody is going to complete a browser flow per container.
Baking tokens into the template only moves the problem to whenever they expire.

So the credentials live outside the workspace lifecycle entirely, and the workspace is given an
address.

[mcporter](https://github.com/steipete/mcporter) runs as a long-lived daemon on a machine that
has a browser — a laptop is fine — holding the OAuth sessions and refreshing them. It exposes
every server it manages over one HTTP endpoint:

```sh
mcporter serve --http 7777 --host 10.0.0.99
```

Bind the LAN address rather than `0.0.0.0`. A laptop joins networks that are not this one, and
`0.0.0.0` offers an unauthenticated bridge to every session it holds on whichever wifi it is on.
On macOS a LaunchAgent with `RunAtLoad` and `KeepAlive` starts it at login; off the LAN the bind
fails and it retries, which is the behaviour worth having.

Then one seed file, `home` root, `.claude.json`:

```json
{
  "mcpServers": {
    "linear": { "type": "http", "url": "http://10.0.0.99:7777/mcp/linear" },
    "datadog": { "type": "http", "url": "http://10.0.0.99:7777/mcp/datadog" }
  }
}
```

`/mcp` serves everything at once; `/mcp/<server>` serves one. Name them individually. A bridge
fronting a dozen servers is several hundred tool definitions in the agent's context before it has
read a line of code, and tool selection gets worse as that list grows.

**A workspace holds no credentials under this arrangement**, which is the part worth keeping. A
disposable container that an agent runs arbitrary commands in never sees a refresh token for your
Linear or your mail. What it has is a URL, and it only works from inside the network.

The corollary: anything that can route to that address can use those servers, seeded or not. The
seed file decides what the agent is *told about*, not what it can reach. `mcporter serve
--servers a,b` and a firewall rule are what actually narrow it.

## Worked example: an output style

Two files, both `home` root:

| Path | Contents |
|---|---|
| `.claude/output-styles/<name>.md` | the style, copied verbatim |
| `.claude/settings.json` | `{ "outputStyle": "<Name>" }` |

The value must match the `name:` in the style's frontmatter, not its filename.

Do not seed your own `settings.json` wholesale. It carries plugins, marketplaces, a status line
and hooks that point at things no container has.
