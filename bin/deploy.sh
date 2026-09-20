#!/usr/bin/env bash
#
# Deploys the controller to its LXC.
#
# This exists because the procedure has been reconstructed from memory more than once, and each
# reconstruction dropped a different step. The steps are not interchangeable and several of them
# only matter in ways that are invisible until much later, so they are written down here rather
# than recalled.
#
#   ./bin/deploy.sh              deploy
#   ./bin/deploy.sh --dry-run    show what would be sent and removed, change nothing
#
set -euo pipefail

HOST="${DEPLOY_HOST:-pve-agents-controller}"
ROOT="${DEPLOY_ROOT:-/opt/pve-agents}"
SERVICE="pve-agents.service"

cd "$(dirname "$0")/.."

# Never sent. .env and data/ are the controller's own state and would be overwritten by whatever
# happens to be in this checkout; node_modules is built on the far side against its own platform;
# dist/ is rebuilt there.
EXCLUDES=(
	--exclude '.git/'
	--exclude 'node_modules/'
	--exclude 'dist/'
	--exclude '.env'
	--exclude '.env.bak-*'
	--exclude 'data/'
	--exclude 'playground/'
	--exclude '.tanstack/'
	--exclude '.nitro/'
	--exclude '.output/'
	--exclude '.DS_Store'
	# The controller reads its SSH key from /var/lib/pve-agents/ssh, so a copy in the
	# checkout is a duplicate of a private key and nothing reads it.
	--exclude 'id_pve_agents_controller*'
)

# -a would carry the developer machine's uid and group across, so every deploy fought the chown at
# the end and a failure between the two left the controller's code owned by a number that means
# nothing on the box. Not sending ownership at all removes the race rather than correcting it.
RSYNC=(rsync -a --no-owner --no-group --delete)

if [ "${1:-}" = "--dry-run" ]; then
	echo "==> would send and remove:"
	"${RSYNC[@]}" -n --itemize-changes "${EXCLUDES[@]}" ./ "$HOST:$ROOT/"
	exit 0
fi

# Refuse to ship something that does not pass here. A controller that fails to build is a
# controller that is down, and finding that out on the far side means finding it out with the
# service already stopped.
echo "==> verifying locally"
pnpm check
pnpm typecheck
pnpm test
pnpm build

# Stopped first, so the tree is not replaced underneath a running process. It also means the
# service's slow shutdown is waited out here rather than colliding with the restart at the end.
echo "==> stopping $SERVICE"
ssh "$HOST" "systemctl stop $SERVICE"

# --delete, and the whole tree rather than a list of paths. Syncing named paths leaves files behind
# that were deleted or renamed in the repository, and a stale module that still resolves is the
# kind of thing that is debugged for an hour.
echo "==> syncing"
"${RSYNC[@]}" "${EXCLUDES[@]}" ./ "$HOST:$ROOT/"

ssh "$HOST" "set -euo pipefail
cd $ROOT
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# node_modules goes first because the previous deploy ended with 'prune --prod'. A plain install
# after a prune reports 'Already up to date' and does not restore devDependencies, so the build
# then fails on a missing Vite. This is the step that looks redundant and is not.
echo '==> installing'
rm -rf node_modules
corepack pnpm install --frozen-lockfile >/dev/null

echo '==> building'
corepack pnpm build >/dev/null

# Before the service starts, not after. The controller applies migrations lazily on the first
# request that touches the database, so skipping this leaves it reporting itself healthy on the old
# schema and surfacing the failure as a broken request instead of a failed deploy.
echo '==> migrating'
corepack pnpm db:migrate

echo '==> pruning'
corepack pnpm prune --prod >/dev/null

# root owns it, the service group reads it. The service user must not own its own code: rsync -a
# also preserves the developer machine's uid, so without this the tree ends up owned by whichever
# local account happened to run the deploy.
echo '==> permissions'
chown -R root:pve-agents $ROOT
chmod 640 $ROOT/.env

echo '==> starting'
systemctl start $SERVICE
"

sleep 4
echo "==> verifying"
ssh "$HOST" "systemctl is-active $SERVICE && curl -sS -o /dev/null -w 'https: %{http_code}\n' https://pve-agents.puff.lan/"
