# Security And Networking

## Network Recommendation

Use a dedicated private agent VLAN or subnet:

```text
Trusted workstation and controller
            |
            | SSH
            v
Agent VLAN / subnet
├── DHCP
├── outbound NAT
├── no public inbound access
└── per-LXC Proxmox firewall enabled
```

Firewall policy should allow:

- SSH into workspace LXCs from the controller only. Nothing else has a reason to.
- Outbound DNS, Git hosting, package registries, and model-provider endpoints.
- No unsolicited inbound internet traffic.
- Access to internal services only when a task explicitly requires it.

The discovered IP is used directly as the SSH target; the hostname `agent-<short id>` is the friendly name and exists for people rather than for resolution. Internal DNS such as `agent-7f2a.agent.internal` would be a convenience, not a fix for anything.

## Address Discovery

Configure the cloned LXC NIC for DHCP and poll:

```text
GET /nodes/{node}/lxc/{vmid}/interfaces
```

Ignore loopback, link-local, and addresses outside the expected subnet. Confirm actual SSH readiness after discovering an address.

If stable addresses become necessary, use one authoritative DHCP/IPAM system with MAC reservations. Do not maintain an independent controller allocation table in parallel with another IPAM.

Proxmox SDN DHCP/IPAM remains documented as a technology preview. Use it only if the homelab already depends on it successfully.

## Tailscale

Running Tailscale inside every workspace is not recommended for the first prototype. It adds enrollment credentials, node cleanup, another readiness dependency, and another identity system.

A Tailscale subnet router is a cleaner later option when client machines cannot directly route to the agent subnet. In that model the LXC remains an ordinary private-subnet host.

## Proxmox Credentials

Use a dedicated Proxmox user and privilege-separated API token. **The controller holds it and nothing else does**: it never reaches a workspace, and no agent can ask for it.

Suggested privileges:

```text
VM.Audit
VM.Clone
VM.Allocate
VM.PowerMgmt
VM.Config.Options
VM.Config.CPU
VM.Config.Memory
VM.Config.Network
Datastore.AllocateSpace
SDN.Use
```

Add `VM.Config.Disk` only if the controller changes disk configuration.

Scope permissions to:

- The golden template for audit and clone.
- The pre-created `disposable-workspaces` pool for managed LXCs.
- The clone storage for allocation.
- The specific bridge or VNet.

Do not grant broad administrator, console, permission-management, or host-modification privileges.

## Template Credentials

Do not bake secrets into the LXC template.

Safe template material includes:

- Controller SSH public key.
- SSH user CA public key.
- SSH host CA public key.
- Public TLS trust roots.
- Non-secret bootstrap configuration.

Unsafe template material includes:

- Proxmox API tokens.
- GitHub access tokens or private deploy keys.
- Model-provider API keys.
- Claude, Codex, or GitHub login state.
- Herdr client credentials.

LXC cloning does not provide QEMU-style cloud-init, and Proxmox does not expose a general REST `pct exec` or `pct push`. The initial bootstrap channel must therefore be prepared in the template or supplied through a separately controlled Proxmox-host mechanism.

Bake a dedicated controller public key for the non-root `agent` account. Keep its private key only on the hosted controller. Consider SSH certificates after the lifecycle is working.

## SSH Host Verification

Each cloned LXC must have unique SSH host keys. Never preserve the template's host private keys across clones.

The policy in use is:

1. Obtain the LXC address and MAC from Proxmox.
2. Confirm they belong to the expected workspace subnet and VMID.
3. Connect with `StrictHostKeyChecking=accept-new` only on that isolated subnet.
4. Store and pin the resulting host key for subsequent connections.
5. Remove the known-host entry when the workspace is destroyed.

This is trust-on-first-use and remains vulnerable to an attacker already positioned on the private subnet. SSH host certificates are the stronger long-term design.

## Git Credentials

GitHub App installation tokens, minted per repository and lasting an hour.

1. Mint a token scoped to that repository alone.
2. Store it with git's `credential.helper store`, written from **stdin** so it is never an argument and never appears in `ps` on the workspace.
3. Clone over HTTPS from a credential-free URL and let git read the stored value itself.
4. Replace the stored credential before the hour is up, for as long as the workspace lives.

**The token is stored rather than used once and deleted**, which is a deliberate departure from the obvious design. The agent pushes later under its own steam, and a workspace outlives an installation token several times over. A refresh pass replaces it on a living workspace without touching its repository.

Never put the token in the URL. git repeats the remote it was using in its error text, and that text reaches the workspace timeline the UI renders. Everything git prints is scrubbed of the token at the boundary too, because one of those paths will be missed eventually.

Avoid forwarding the user's general SSH agent into an autonomous workspace. It grants broader signing and repository access than the task usually needs.

## Model Provider Credentials

Provider authentication is the largest unavoidable trade-off here, and the one that was settled least comfortably.

**What is used: a Claude subscription OAuth token**, held in `.env` on the controller and written into each workspace as a file the agent pane's shell sources. It arrives over stdin, never as an argument. An API key was available and was deliberately not chosen.

It is the fourth option on the list below, and it is chosen knowingly: this is a single-operator deployment, the token is reusable rather than task-scoped, and any workspace that gets it can spend against the subscription. The container being disposable is what bounds that, not the credential.

Better, in order, if this ever stops being a single-operator tool:

1. Short-lived, task-scoped provider credential.
2. Controller-side credential broker that exchanges a workspace identity for limited access.
3. Narrowly scoped API key injected as a mode `0600` file.
4. Reusable login state, which is what is in use.

Track which credential classes were injected, never their values. Remove credential files during destruction even though deleting the LXC also removes its filesystem.

## The controller's own exposure

The web UI is the interactive path, so the controller holds more than a provisioning service would.

- **It can reach every workspace over SSH** with a key that is on the controller and nowhere else. Anyone who reaches the controller reaches every live workspace.
- **Auth is off unless `CONTROLLER_AUTH_SECRET` is set.** Without it there is no sign-in and no API key, and the only thing between the controller and a caller is the network it sits on.
- **The agent's screen is rendered as parsed spans, never as HTML.** An agent echoes file contents, diffs, and whatever a prompt told it to print. Handing that to an HTML converter would let any repository script the controller's own origin, where the operator's session cookie lives.
- **`ssh` does not preserve argument boundaries.** It joins the command and the remote shell splits it again, so every argument is quoted before it leaves. Without that, a repository name or an agent prompt carrying a semicolon is remote code execution under the controller's key.

A local Herdr bridge was specified here and never built. The web UI removed the reason for it: an operator watches and drives the agent in the browser rather than registering each workspace into their own Herdr sidebar.
