#!/usr/bin/env bash
#
# Builds the golden workspace template, on the Proxmox host, as root.
#
# Clones an existing template into a scratch container, provisions it, then converts that into a
# new template. The source is never modified, so a bad build costs nothing: delete the scratch
# VMID and leave PROXMOX_TEMPLATE_VMID pointing at the old one.
#
# Why a rebuild rather than editing the template in place: linked clones are taken from the
# template's `@__base__` ZFS snapshot, not its live dataset. Mounting a template and writing to it
# changes nothing that any future clone will ever see.
#
# The default source is the template in service, so a rebuild starts from what is known to work
# rather than from whichever ancestor happens to still exist. 107 and 114 were the earlier ones
# and have been deleted; a template built by this script is a full clone, so nothing depended on
# them once the current one existed.
#
# Which template is in service lives in .env, not here, so there is one answer rather than two
# that can disagree. Keep this default in step with it after a rebuild.
#
#   NEW_VMID=121 ./build-workspace-template.sh
#
# The first template on a fresh host has nothing to clone, so `SOURCE_VMID=` (explicitly empty)
# selects bootstrap mode and builds from a stock Ubuntu 24.04 LXC image instead:
#
#   SOURCE_VMID= NEW_VMID=120 ./build-workspace-template.sh
#
# Every provisioning step below is the same in both modes. Bootstrap is only a different way of
# getting an empty container; it is not a reduced build.
#
set -euo pipefail

# `${VAR-default}` rather than `${VAR:-default}`: an explicitly empty SOURCE_VMID has to survive,
# because that is what selects bootstrap mode. With a colon it would become 120 again.
SOURCE_VMID="${SOURCE_VMID-120}"
NEW_VMID="${NEW_VMID:-}"
STORAGE="${STORAGE:-local-zfs}"
WORKSPACE_USER="${WORKSPACE_USER:-agent}"
CONTROLLER_PUBKEY="${CONTROLLER_PUBKEY:-/root/id_pve_agents_controller.pub}"
NODE_MAJOR="${NODE_MAJOR:-22}"

# Bootstrap-only. Ubuntu 24.04 is the agreed base: the NodeSource script, the gh apt repository and
# Ubuntu's own golang-go/rustc/cargo all work there unmodified, which is not true of every image
# pveam offers.
BASE_IMAGE="${BASE_IMAGE:-ubuntu-24.04-standard_24.04-2_amd64.tar.zst}"
BASE_IMAGE_STORAGE="${BASE_IMAGE_STORAGE:-local}"
BRIDGE="${BRIDGE:-vmbr0}"
# The Agent SDK alone is about 245 MB, and Go and Rust are not small either. A template that runs
# out of disk halfway through an apt transaction fails in a way that reads like a network problem.
ROOTFS_SIZE="${ROOTFS_SIZE:-16}"
MEMORY="${MEMORY:-4096}"
CORES="${CORES:-4}"

log() { printf '\n==> %s\n' "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

# The container is stopped and destroyed on any failure, so a half-provisioned scratch container
# is never left behind to be mistaken for a finished template.
cleanup() {
	local code=$?
	if [ "$code" -ne 0 ] && [ -n "${PROVISIONED:-}" ]; then
		cat >&2 <<KEPT

Container $NEW_VMID was provisioned but failed its checks, so it has been kept rather than
destroyed. Inspect it with: pct start $NEW_VMID && pct exec $NEW_VMID -- bash
Remove it with: pct destroy $NEW_VMID --purge
KEPT
		return
	fi
	if [ "$code" -ne 0 ] && [ -n "${SCRATCH_CREATED:-}" ]; then
		printf '\nfailed; removing scratch container %s\n' "$NEW_VMID" >&2
		pct stop "$NEW_VMID" >/dev/null 2>&1 || true
		pct destroy "$NEW_VMID" --purge >/dev/null 2>&1 || true
	fi
}
trap cleanup EXIT

command -v pct >/dev/null || fail "pct not found; run this on the Proxmox host"
[ -f "$CONTROLLER_PUBKEY" ] || fail "controller public key not found at $CONTROLLER_PUBKEY"
grep -q '^ssh-' "$CONTROLLER_PUBKEY" || fail "$CONTROLLER_PUBKEY is not an SSH public key"

BASE_IMAGE_VOLUME="${BASE_IMAGE_STORAGE}:vztmpl/${BASE_IMAGE}"
if [ -n "$SOURCE_VMID" ]; then
	pct config "$SOURCE_VMID" >/dev/null 2>&1 || fail "source template $SOURCE_VMID does not exist"
	pct config "$SOURCE_VMID" | grep -q '^template: 1' || fail "$SOURCE_VMID is not a template"
else
	# Named rather than implied: bootstrap is the unusual path and the one somebody reaches for
	# when they have no idea what the normal path looks like.
	log "bootstrap mode: no source template, building from $BASE_IMAGE"
	pveam list "$BASE_IMAGE_STORAGE" 2>/dev/null | grep -q "$BASE_IMAGE" || fail \
		"$BASE_IMAGE is not downloaded. Get it with:
    pveam update && pveam download $BASE_IMAGE_STORAGE $BASE_IMAGE
  pveam available --section system  lists what this host can fetch."
fi

if [ -z "$NEW_VMID" ]; then
	NEW_VMID=$(pvesh get /cluster/nextid)
fi
if pct config "$NEW_VMID" >/dev/null 2>&1; then
	fail "$NEW_VMID already exists; pass NEW_VMID= for an unused id"
fi

if [ -n "$SOURCE_VMID" ]; then
	log "full clone $SOURCE_VMID -> $NEW_VMID on $STORAGE"
	# Full, not linked: the result becomes a template in its own right and must not depend on the
	# source's snapshot staying around.
	pct clone "$SOURCE_VMID" "$NEW_VMID" \
		--full 1 \
		--storage "$STORAGE" \
		--hostname "pve-agents-template-build"
else
	log "creating $NEW_VMID from $BASE_IMAGE_VOLUME on $STORAGE"
	# Unprivileged, matching what the clones will be. A template built privileged produces a fleet
	# of privileged containers, which is the opposite of what a disposable workspace should be.
	#
	# DHCP because address discovery polls Proxmox for whatever the container got; a static
	# address here would be baked into every clone and collide on the second one.
	pct create "$NEW_VMID" "$BASE_IMAGE_VOLUME" \
		--hostname "pve-agents-template-build" \
		--rootfs "${STORAGE}:${ROOTFS_SIZE}" \
		--memory "$MEMORY" \
		--cores "$CORES" \
		--net0 "name=eth0,bridge=${BRIDGE},ip=dhcp" \
		--unprivileged 1 \
		--features nesting=1 \
		--onboot 0
fi
SCRATCH_CREATED=1

log "starting $NEW_VMID"
pct start "$NEW_VMID"

log "waiting for network"
for _ in $(seq 1 60); do
	if pct exec "$NEW_VMID" -- getent hosts deb.debian.org >/dev/null 2>&1 ||
		pct exec "$NEW_VMID" -- getent hosts archive.ubuntu.com >/dev/null 2>&1; then
		break
	fi
	sleep 2
done
pct exec "$NEW_VMID" -- getent hosts archive.ubuntu.com >/dev/null 2>&1 ||
	fail "container has no DNS; check the bridge and DHCP"

log "installing base packages"
# fd-find installs the binary as `fdfind`, because Debian already had an `fd`. Everything that
# reaches for it — an agent, a CLAUDE.md, a person in the Terminal tab — calls it `fd`, so the
# symlink is part of installing it rather than a nicety.
pct exec "$NEW_VMID" -- bash -eux -c '
	export DEBIAN_FRONTEND=noninteractive
	apt-get update
	apt-get install -y --no-install-recommends \
		build-essential ca-certificates curl fd-find git gnupg jq openssh-server \
		python3 python3-venv ripgrep unzip
	ln -sf "$(command -v fdfind)" /usr/local/bin/fd
'

log "installing gh"
pct exec "$NEW_VMID" -- bash -eux -c '
	export DEBIAN_FRONTEND=noninteractive
	install -d -m 0755 /etc/apt/keyrings
	curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
		-o /etc/apt/keyrings/githubcli-archive-keyring.gpg
	chmod 0644 /etc/apt/keyrings/githubcli-archive-keyring.gpg
	echo "deb [signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
		> /etc/apt/sources.list.d/github-cli.list
	apt-get update
	apt-get install -y --no-install-recommends gh
'

log "installing node ${NODE_MAJOR} and pnpm"
pct exec "$NEW_VMID" -- bash -eux -c "
	export DEBIAN_FRONTEND=noninteractive
	curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash -
	apt-get install -y --no-install-recommends nodejs
	corepack enable
	corepack prepare pnpm@latest --activate
"

log "installing go and rust"
pct exec "$NEW_VMID" -- bash -eux -c '
	export DEBIAN_FRONTEND=noninteractive
	apt-get install -y --no-install-recommends golang-go rustc cargo
'

log "giving ${WORKSPACE_USER} a real shell and a home"
pct exec "$NEW_VMID" -- bash -eux -c "
	id -u ${WORKSPACE_USER} >/dev/null 2>&1 || useradd --create-home --shell /bin/bash ${WORKSPACE_USER}
	usermod --shell /bin/bash ${WORKSPACE_USER}
	install -d -o ${WORKSPACE_USER} -g ${WORKSPACE_USER} -m 0755 /home/${WORKSPACE_USER}
	install -d -o ${WORKSPACE_USER} -g ${WORKSPACE_USER} -m 0700 /home/${WORKSPACE_USER}/.ssh
	install -d -o ${WORKSPACE_USER} -g ${WORKSPACE_USER} -m 0755 /home/${WORKSPACE_USER}/.local/bin
	install -d -o ${WORKSPACE_USER} -g ${WORKSPACE_USER} -m 0755 /workspace
"

# The agent tooling was installed under root in the source template, so it was not on the
# workspace user's PATH at all. Copying preserves the pinned versions; reinstalling would silently
# move them.
log "moving agent tooling under /home/${WORKSPACE_USER}"
pct exec "$NEW_VMID" -- bash -eux -c "
	for tool in herdr uv uvx; do
		if [ -x /root/.local/bin/\$tool ]; then
			cp -a /root/.local/bin/\$tool /home/${WORKSPACE_USER}/.local/bin/\$tool
		fi
	done
	if [ -d /root/.opencode ]; then
		cp -a /root/.opencode /home/${WORKSPACE_USER}/.opencode
		if [ -x /home/${WORKSPACE_USER}/.opencode/bin/opencode ]; then
			ln -sf /home/${WORKSPACE_USER}/.opencode/bin/opencode /usr/local/bin/opencode
		fi
	fi
	chown -R ${WORKSPACE_USER}:${WORKSPACE_USER} /home/${WORKSPACE_USER}

	# ssh host command runs a non-login, non-interactive shell, which sources neither .profile nor
	# .bashrc, so ~/.local/bin is not on PATH there. That is exactly how the controller invokes
	# herdr, so the tooling has to be reachable without a login shell.
	for tool in /home/${WORKSPACE_USER}/.local/bin/*; do
		[ -x \"\$tool\" ] && ln -sf \"\$tool\" /usr/local/bin/\"\$(basename \"\$tool\")\"
	done
"

# uv, bun and opencode used to arrive only by being copied out of the ancestor template's /root,
# just above. That worked for a rebuild and produced nothing at all on a bootstrap build, which
# then failed verification — so they are installed explicitly here and both modes converge on the
# same tooling. The copy above stays: it preserves the versions a working template was pinned to,
# and these installers are no-ops over an existing binary of the same name.
log "installing uv, bun and opencode for ${WORKSPACE_USER}"
# As the workspace user, not root: tooling under /root is not on this user's PATH, which makes it
# invisible to everything the controller does over SSH.
pct exec "$NEW_VMID" -- su - "$WORKSPACE_USER" -s /bin/bash -c '
	set -eux
	command -v uv >/dev/null 2>&1 || curl -fsSL https://astral.sh/uv/install.sh | sh
	command -v bun >/dev/null 2>&1 || curl -fsSL https://bun.sh/install | bash
	command -v opencode >/dev/null 2>&1 || curl -fsSL https://opencode.ai/install | bash
'
# Each installer drops into its own directory and appends to a shell rc file, which a non-login
# `ssh host command` never reads. The symlink loop below is the same mechanism the copied tooling
# relies on, applied to what was just installed.
pct exec "$NEW_VMID" -- bash -eux -c "
	for dir in /home/${WORKSPACE_USER}/.local/bin /home/${WORKSPACE_USER}/.bun/bin /home/${WORKSPACE_USER}/.opencode/bin; do
		[ -d \"\$dir\" ] || continue
		for tool in \"\$dir\"/*; do
			[ -x \"\$tool\" ] && ln -sf \"\$tool\" /usr/local/bin/\"\$(basename \"\$tool\")\"
		done
	done
	chown -R ${WORKSPACE_USER}:${WORKSPACE_USER} /home/${WORKSPACE_USER}
"

log "installing coding agents for ${WORKSPACE_USER}"
# The agent SDK is what the controller's runner imports. It goes in the template rather than being
# installed per workspace because it carries its own Claude Code binary and weighs about 245 MB;
# workspaces are linked clones of one ZFS snapshot, so the template pays that once for the fleet.
#
# The runner reaches it through a symlink to this global root, created at install time. NODE_PATH
# does not work: it is a CommonJS mechanism and node's ESM resolver ignores it, and the runner is
# an ES module.
pct exec "$NEW_VMID" -- bash -eux -c "
	export DEBIAN_FRONTEND=noninteractive
	npm install -g @anthropic-ai/claude-code @openai/codex @anthropic-ai/claude-agent-sdk
"

log "authorising the controller key"
# Passed as a literal so this works whether or not the host and container share a filesystem.
PUBKEY="$(cat "$CONTROLLER_PUBKEY")"
pct exec "$NEW_VMID" -- bash -eux -c "
	printf '%s\n' '${PUBKEY}' > /home/${WORKSPACE_USER}/.ssh/authorized_keys
	chown ${WORKSPACE_USER}:${WORKSPACE_USER} /home/${WORKSPACE_USER}/.ssh/authorized_keys
	chmod 0600 /home/${WORKSPACE_USER}/.ssh/authorized_keys
	systemctl enable ssh
"

# Host keys must be unique per clone. Leaving the template's keys in place would give every
# workspace the same identity, which defeats host verification entirely.
log "clearing per-clone identity"
pct exec "$NEW_VMID" -- bash -eux -c '
	rm -f /etc/ssh/ssh_host_*
	systemctl enable ssh-keygen.service 2>/dev/null || true
	cat > /etc/systemd/system/regenerate-ssh-host-keys.service <<UNIT
[Unit]
Description=Regenerate SSH host keys on first boot
ConditionPathExistsGlob=!/etc/ssh/ssh_host_*_key
Before=ssh.service

[Service]
Type=oneshot
ExecStart=/usr/bin/ssh-keygen -A
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
UNIT
	systemctl enable regenerate-ssh-host-keys.service
	rm -f /etc/machine-id /var/lib/dbus/machine-id
	touch /etc/machine-id
'

log "trimming the image"
pct exec "$NEW_VMID" -- bash -eux -c '
	export DEBIAN_FRONTEND=noninteractive
	apt-get clean
	rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*
	rm -f /root/.bash_history "/home/'"${WORKSPACE_USER}"'/.bash_history"
	truncate -s 0 /var/log/*.log 2>/dev/null || true
'

# Past this point the container is fully provisioned; a failure is worth inspecting, not deleting.
PROVISIONED=1

log "verifying before converting"
pct exec "$NEW_VMID" -- bash -eu -c "
	missing=
	for tool in git gh node pnpm python3 go rustc rg fd jq sshd; do
		command -v \$tool >/dev/null 2>&1 || missing=\"\$missing \$tool(root)\"
	done
	# Checked without a login shell, because that is how the controller reaches them over SSH.
	# herdr was here and is not: it was removed from the controller, and requiring its binary to
	# convert a template would block every build for a dependency nothing calls any more.
	for tool in uv bun opencode claude codex; do
		su ${WORKSPACE_USER} -s /bin/sh -c \"command -v \$tool\" >/dev/null 2>&1 ||
			missing=\"\$missing \$tool(${WORKSPACE_USER}, non-login)\"
	done
	[ -s /home/${WORKSPACE_USER}/.ssh/authorized_keys ] || missing=\"\$missing authorized_keys\"
	# Not a binary on PATH, so checked by the path the runner actually resolves it through: a
	# symlink to this global root. Without this the template converts happily and every workspace
	# built from it dies at runner start with ERR_MODULE_NOT_FOUND.
	[ -d /usr/lib/node_modules/@anthropic-ai/claude-agent-sdk ] ||
		missing=\"\$missing claude-agent-sdk(/usr/lib/node_modules)\"
	if [ -n \"\$missing\" ]; then
		echo \"missing:\$missing\" >&2
		exit 1
	fi
	echo 'all required tooling present'
"

log "stopping and converting $NEW_VMID to a template"
pct stop "$NEW_VMID"
pct set "$NEW_VMID" --hostname "pve-agents-template"
pct template "$NEW_VMID"
SCRATCH_CREATED=
PROVISIONED=

cat <<SUMMARY

Template $NEW_VMID built from ${SOURCE_VMID:-$BASE_IMAGE}.

Point the controller at it and restart:

  ssh pve-agents-controller
  sed -i 's/^PROXMOX_TEMPLATE_VMID=.*/PROXMOX_TEMPLATE_VMID=$NEW_VMID/' /opt/pve-agents/.env
  systemctl restart pve-agents.service

The Proxmox token needs VM.Audit and VM.Clone on /vms/$NEW_VMID, or cloning fails with 403.
SUMMARY

if [ -n "$SOURCE_VMID" ]; then
	cat <<SUMMARY
It currently holds them on /vms/$SOURCE_VMID only.

$SOURCE_VMID is untouched. Revert by putting it back in .env.
SUMMARY
else
	# Said out loud because bootstrap is the one build with nothing to fall back to, and that is
	# worth knowing before the first workspace rather than after it.
	cat <<SUMMARY

This was a bootstrap build, so there is no earlier template to revert to. Keep $NEW_VMID until a
workspace has been built from it and the agent has answered a prompt.
SUMMARY
fi
