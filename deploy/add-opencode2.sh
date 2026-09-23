#!/usr/bin/env bash
#
# Adds opencode2 to the golden workspace template, on the Proxmox host, as root.
#
# A script of its own rather than another step in build-workspace-template.sh, because that one is
# a full build from a base image and this is one npm install. Rebuilding an entire template to add
# a package is twenty minutes to change one line, and the two scripts are being worked on at once.
#
# Same shape as its neighbour, and for the same reasons: full-clone the template in service into a
# scratch VMID, install, verify, convert. The source is never touched, so a bad build costs a
# `pct destroy` and leaves PROXMOX_TEMPLATE_VMID pointing at what already works.
#
# opencode2 is the v2 beta, and it installs *beside* v1 rather than over it — different package,
# different binary name. Both are verified below, because the existing harness has nothing to do
# with this and must not be disturbed by it.
#
#   SOURCE_VMID=120 ./add-opencode2.sh
#
set -euo pipefail

SOURCE_VMID="${SOURCE_VMID:-120}"
NEW_VMID="${NEW_VMID:-}"
STORAGE="${STORAGE:-local-zfs}"
WORKSPACE_USER="${WORKSPACE_USER:-agent}"
# The dist-tag, not a version. Pinning here would go stale the day after it was written; the build
# actually installed is read back off the container and printed, which is the number to quote when
# something behaves differently next month.
OPENCODE_TAG="${OPENCODE_TAG:-beta}"

log() { printf '\n==> %s\n' "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

# A container that failed its checks is kept rather than destroyed: the whole value of a check is
# being able to go and look at what it caught.
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
	--hostname "pve-agents-template-opencode2"
SCRATCH_CREATED=1

log "starting $NEW_VMID"
pct start "$NEW_VMID"

log "waiting for network"
for _ in $(seq 1 60); do
	if pct exec "$NEW_VMID" -- getent hosts registry.npmjs.org >/dev/null 2>&1; then
		break
	fi
	sleep 2
done
pct exec "$NEW_VMID" -- getent hosts registry.npmjs.org >/dev/null 2>&1 ||
	fail "container cannot resolve registry.npmjs.org; check the bridge and DHCP"

log "installing opencode2 (@opencode-ai/cli@${OPENCODE_TAG})"
# Globally as root, then linked into /usr/local/bin, because the controller reaches these over a
# non-login non-interactive ssh command, which sources neither .profile nor .bashrc. Anything only
# on the workspace user's ~/.local/bin PATH is invisible there -- the same trap the template build
# documents for herdr.
#
# npm rather than the install script: during the v2 beta the standalone binaries, Homebrew and the
# distro packages are all unsupported, and npm is one of the few routes that exists.
pct exec "$NEW_VMID" -- bash -eux -c "
	export DEBIAN_FRONTEND=noninteractive
	npm install -g @opencode-ai/cli@${OPENCODE_TAG}
	for tool in opencode2; do
		bin=\$(command -v \$tool || true)
		[ -n \"\$bin\" ] && ln -sf \"\$bin\" /usr/local/bin/\$tool
	done
"

# Past this point the container is provisioned; a failure is worth inspecting, not deleting.
PROVISIONED=1

log "verifying before converting"
# Read back rather than assumed. `@beta` moves, so the build that ended up in this template is a
# fact about this template and nowhere else records it.
OPENCODE2_BUILD=$(pct exec "$NEW_VMID" -- su "${WORKSPACE_USER}" -s /bin/sh -c "opencode2 --version" 2>/dev/null || true)
pct exec "$NEW_VMID" -- bash -eu -c "
	missing=
	# Checked without a login shell, because that is how the controller reaches them over SSH.
	for tool in opencode2 opencode claude codex node; do
		su ${WORKSPACE_USER} -s /bin/sh -c \"command -v \$tool\" >/dev/null 2>&1 ||
			missing=\"\$missing \$tool(${WORKSPACE_USER}, non-login)\"
	done
	# v1 is not being replaced. It installs beside v2 by design, the existing harness does not use
	# either of them yet, and a v2 install that quietly removed v1 would be a surprise waiting for
	# whoever depends on it next.
	[ -d /usr/lib/node_modules/@anthropic-ai/claude-agent-sdk ] ||
		missing=\"\$missing claude-agent-sdk(/usr/lib/node_modules)\"
	if [ -n \"\$missing\" ]; then
		echo \"missing:\$missing\" >&2
		exit 1
	fi
	echo 'all required tooling present'
"
[ -n "$OPENCODE2_BUILD" ] || fail "opencode2 installed but would not report a version"

log "trimming"
pct exec "$NEW_VMID" -- bash -eux -c '
	export DEBIAN_FRONTEND=noninteractive
	rm -rf /root/.npm /tmp/* /var/tmp/*
	rm -f /root/.bash_history
'

log "stopping and converting $NEW_VMID to a template"
pct stop "$NEW_VMID"
pct template "$NEW_VMID"

cat <<SUMMARY

Template $NEW_VMID built from $SOURCE_VMID, with opencode2 added.

  opencode2 $OPENCODE2_BUILD

Quote that build when writing anything against opencode2's API: @beta moves, and this is the only
record of which one this template holds.

Point the controller at it:

  ssh pve-agents-controller
  sed -i 's/^PROXMOX_TEMPLATE_VMID=.*/PROXMOX_TEMPLATE_VMID=$NEW_VMID/' /opt/pve-agents/.env
  systemctl restart pve-agents.service

The Proxmox token needs VM.Audit and VM.Clone on /vms/$NEW_VMID, or cloning fails with 403. It
currently holds them on /vms/$SOURCE_VMID only.

$SOURCE_VMID is untouched. Revert by putting it back in .env.
SUMMARY
