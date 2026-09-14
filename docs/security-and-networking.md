# Security And Networking

## Network Recommendation

Use a dedicated private agent VLAN or subnet for v0:

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

- SSH into workspace LXCs only from authorized Herdr clients and the controller.
- Outbound DNS, Git hosting, package registries, and model-provider endpoints.
- No unsolicited inbound internet traffic.
- Access to internal services only when a task explicitly requires it.

For v0, use the discovered IP directly in the Herdr SSH target. Herdr's machine label provides the friendly name. Internal DNS such as `agent-7f2a.agent.internal` can follow after DHCP and lifecycle behavior are proven.

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

Use a dedicated Proxmox user and privilege-separated API token. The controller stores the token; organiser agents and local Herdr bridges do not receive it.

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

For v0, bake a dedicated controller public key for the non-root `agent` account. Keep its private key only on the hosted controller. Consider SSH certificates after the lifecycle is working.

## SSH Host Verification

Each cloned LXC must have unique SSH host keys. Never preserve the template's host private keys across clones.

The pragmatic v0 policy is:

1. Obtain the LXC address and MAC from Proxmox.
2. Confirm they belong to the expected workspace subnet and VMID.
3. Connect with `StrictHostKeyChecking=accept-new` only on that isolated subnet.
4. Store and pin the resulting host key for subsequent connections.
5. Remove the known-host entry when the workspace is destroyed.

This is trust-on-first-use and remains vulnerable to an attacker already positioned on the private subnet. SSH host certificates are the stronger long-term design.

## Git Credentials

Prefer GitHub App installation tokens:

1. Validate the requested repository against allowed organizations or installations.
2. Mint a short-lived token scoped to that repository.
3. Clone over HTTPS using an ephemeral askpass helper.
4. Set `origin` to a credential-free URL.
5. Delete the helper and token immediately after cloning.

Avoid forwarding the user's general SSH agent into an autonomous workspace. It grants broader signing and repository access than the task usually needs.

## Model Provider Credentials

Provider authentication is likely the largest unavoidable v0 trade-off.

Preferred order:

1. Short-lived, task-scoped provider credential.
2. Controller-side credential broker that exchanges a workspace identity for limited access.
3. Narrowly scoped API key injected as a mode `0600` file.
4. Reusable copied CLI login state only for an explicit single-user prototype.

Track which credential classes were injected, never their values. Remove credential files during destruction even though deleting the LXC also removes its filesystem.

## Local Bridge Security

The local Herdr bridge should:

- Make an authenticated outbound connection to the controller.
- Accept only machine-profile reconciliation messages.
- Validate SSH targets against configured agent subnets or controller-signed workspace records.
- Never execute arbitrary commands sent by the controller.
- Never hold Proxmox or model-provider credentials.
- Use the supported Herdr machine CLI rather than editing internal state files.

The bridge's authority is limited but meaningful: it can add SSH destinations to the user's Herdr interface. Device authorization and target validation are therefore required.
