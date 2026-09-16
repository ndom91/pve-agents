#!/bin/sh
# Runs a controller CLI entrypoint with the configuration it needs.
#
# NODE_EXTRA_CA_CERTS cannot come from .env the way every other setting does: Node reads it while
# bootstrapping, before --env-file is processed, so a value there is silently ignored. The systemd
# unit sets it as a real environment variable; anything run by hand needs this shim, or TLS to a
# Proxmox host using the LAN CA fails with UNABLE_TO_VERIFY_LEAF_SIGNATURE.
set -e

if [ -z "$NODE_EXTRA_CA_CERTS" ] && [ -f .env ]; then
	CA=$(sed -n 's/^NODE_EXTRA_CA_CERTS=//p' .env | head -1)
	if [ -n "$CA" ]; then
		export NODE_EXTRA_CA_CERTS="$CA"
	fi
fi

exec node --env-file-if-exists=.env "$@"
