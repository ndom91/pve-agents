#!/usr/bin/env bash
#
# Read an opencode credential out of a workspace, for pasting into Settings → Agents.
#
# opencode will only mint a credential through a device flow, which needs a person with a browser.
# So the shape of this is: sign in once, inside one workspace, then carry the result to the
# controller — where it is stored on a harness row and written into every workspace provisioned
# after it. This is what `claude setup-token` is for the other agent.
#
#   ssh agent@<workspace> 'opencode2 auth login openai --method chatgpt-headless'
#   ./deploy/harvest-opencode-credential.sh <workspace-ip>
#
# It prints one JSON envelope and nothing else, so it can be piped or copied without picking a
# credential out of surrounding prose. Run it on the controller: it reaches the workspace with the
# controller's own key, which is already the only thing that can.
#
# The credential expires. The access token lasts about ten days and opencode refreshes itself with
# the refresh token beside it, but each workspace has its own store and refreshes independently, so
# the copy on the harness row does not move. Re-harvest when workspaces stop authenticating.

set -euo pipefail

WORKSPACE="${1:-}"
KEY="${WORKSPACE_SSH_KEY_PATH:-/var/lib/pve-agents/ssh/id_pve_agents_controller}"
USER_NAME="${WORKSPACE_SSH_USER:-agent}"
INTEGRATION="${INTEGRATION:-openai}"

fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

[ -n "$WORKSPACE" ] || fail "usage: harvest-opencode-credential.sh <workspace-ip> [INTEGRATION=openai]"
[ -f "$KEY" ] || fail "no ssh key at $KEY; set WORKSPACE_SSH_KEY_PATH"

# Read on the far side and printed as one line. The credential never touches a file here, and the
# only thing that ever holds it is this command's stdout, which is where it was asked for.
#
# `node:sqlite` rather than a sqlite3 binary: node 22 has it built in and the workspace template
# does not install sqlite3.
set +e
VALUE=$(ssh -i "$KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
	-o "UserKnownHostsFile=$(dirname "$KEY")/known_hosts" \
	"${USER_NAME}@${WORKSPACE}" \
	"node -e \"
const { DatabaseSync } = require('node:sqlite');
const store = process.env.HOME + '/.local/share/opencode/opencode.db';
// A store that does not exist and a store with no row are one situation to the person reading
// this: opencode has not been signed in here. Both leave by the same door.
let row;
try {
  row = new DatabaseSync(store, { readOnly: true })
    .prepare('select value from credential where integration_id = ? and active = 1')
    .get('${INTEGRATION}');
} catch { process.exit(3); }
if (row === undefined) { process.exit(3); }
process.stdout.write(row.value);
\" 2>/dev/null")
STATUS=$?
set -e

# Told apart rather than lumped together. The first version reported an unreachable workspace as
# "no credential there", which sends an operator to sign in again at a container that is not
# running -- and this script's whole job is to be used on the day a credential stopped working,
# when a misleading reason costs the most.
case "$STATUS" in
	0) ;;
	3) fail "no active ${INTEGRATION} credential in that workspace; sign in there first with: opencode2 auth login ${INTEGRATION} --method chatgpt-headless" ;;
	255) fail "could not reach ${WORKSPACE}; is that workspace still running?" ;;
	*) fail "reading the credential failed on ${WORKSPACE} (exit ${STATUS})" ;;
esac

[ -n "$VALUE" ] || fail "the ${INTEGRATION} credential is empty"

# The envelope the harness expects. The integration is a separate column in opencode's own table and
# the value does not name itself, so both are carried.
node -e "
const value = require('node:fs').readFileSync(0, 'utf8');
process.stdout.write(JSON.stringify({ integration: '${INTEGRATION}', value }) + '\n');
" <<< "$VALUE"
