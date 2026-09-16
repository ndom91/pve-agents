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
#   SOURCE_VMID=107 NEW_VMID=120 ./build-workspace-template.sh
#
set -euo pipefail

SOURCE_VMID="${SOURCE_VMID:-107}"
NEW_VMID="${NEW_VMID:-}"
STORAGE="${STORAGE:-local-zfs}"
WORKSPACE_USER="${WORKSPACE_USER:-agent}"
CONTROLLER_PUBKEY="${CONTROLLER_PUBKEY:-/root/id_herdr_controller.pub}"
NODE_MAJOR="${NODE_MAJOR:-22}"

log() { printf '\n==> %s\n' "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

# The container is stopped and destroyed on any failure, so a half-provisioned scratch container
# is never left behind to be mistaken for a finished template.
cleanup() {
	local code=$?
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
pct config "$SOURCE_VMID" >/dev/null 2>&1 || fail "source template $SOURCE_VMID does not exist"
pct config "$SOURCE_VMID" | grep -q '^template: 1' || fail "$SOURCE_VMID is not a template"

if [ -z "$NEW_VMID" ]; then
	NEW_VMID=$(pvesh get /cluster/nextid)
fi
if pct config "$NEW_VMID" >/dev/null 2>&1; then
	fail "$NEW_VMID already exists; pass NEW_VMID= for an unused id"
fi

log "full clone $SOURCE_VMID -> $NEW_VMID on $STORAGE"
# Full, not linked: the result becomes a template in its own right and must not depend on the
# source's snapshot staying around.
pct clone "$SOURCE_VMID" "$NEW_VMID" \
	--full 1 \
	--storage "$STORAGE" \
	--hostname "herdr-template-build"
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
pct exec "$NEW_VMID" -- bash -eux -c '
	export DEBIAN_FRONTEND=noninteractive
	apt-get update
	apt-get install -y --no-install-recommends \
		build-essential ca-certificates curl git gnupg jq openssh-server \
		python3 python3-venv ripgrep unzip
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
	fi
	chown -R ${WORKSPACE_USER}:${WORKSPACE_USER} /home/${WORKSPACE_USER}
"

log "installing coding agents for ${WORKSPACE_USER}"
pct exec "$NEW_VMID" -- bash -eux -c "
	export DEBIAN_FRONTEND=noninteractive
	npm install -g @anthropic-ai/claude-code @openai/codex
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

log "verifying before converting"
pct exec "$NEW_VMID" -- bash -eu -c "
	missing=
	for tool in git gh node pnpm python3 uv go rustc rg jq sshd; do
		command -v \$tool >/dev/null 2>&1 || missing=\"\$missing \$tool\"
	done
	for tool in herdr claude codex; do
		su - ${WORKSPACE_USER} -c \"command -v \$tool\" >/dev/null 2>&1 || missing=\"\$missing \$tool(${WORKSPACE_USER})\"
	done
	[ -s /home/${WORKSPACE_USER}/.ssh/authorized_keys ] || missing=\"\$missing authorized_keys\"
	if [ -n \"\$missing\" ]; then
		echo \"missing:\$missing\" >&2
		exit 1
	fi
	echo 'all required tooling present'
"

log "stopping and converting $NEW_VMID to a template"
pct stop "$NEW_VMID"
pct set "$NEW_VMID" --hostname "herdr-template"
pct template "$NEW_VMID"
SCRATCH_CREATED=

cat <<SUMMARY

Template $NEW_VMID built from $SOURCE_VMID.

Point the controller at it and restart:

  ssh herdr-controller
  sed -i 's/^PROXMOX_TEMPLATE_VMID=.*/PROXMOX_TEMPLATE_VMID=$NEW_VMID/' /opt/pve-herdr-agents/.env
  systemctl restart pve-herdr-agents.service

The Proxmox token needs VM.Audit and VM.Clone on /vms/$NEW_VMID; it currently holds them on
/vms/$SOURCE_VMID only, so cloning will fail with 403 until that is granted.

$SOURCE_VMID is untouched. Revert by putting it back in .env.
SUMMARY
