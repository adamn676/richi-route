#!/bin/bash
# Run once in Terminal on the Mac itself (not over SSH): copies the development
# signing identity into its own keychain, whose password sits in a file only you can read, so that
# builds over SSH can unlock it and sign for the iPhone without the login password.
set -euo pipefail

keychain="$HOME/Library/Keychains/richiroute-signing.keychain-db"
passfile="$HOME/.richiroute-signing"

if [ -e "$keychain" ]; then
  echo "$keychain already exists; delete it first (security delete-keychain \"$keychain\") to start over" >&2
  exit 1
fi

tmp=$(mktemp -d)
# a failed run leaves nothing behind, so it can simply run again
trap 'status=$?; rm -rf "$tmp"; if [ $status -ne 0 ]; then security delete-keychain "$keychain" 2>/dev/null || true; rm -f "$passfile"; fi' EXIT

# first, as it is what can fail: the Mac asks on its own screen, so this runs in Terminal there
p12=$tmp/identities.p12
p12password=$(openssl rand -hex 16)
security export -k "$HOME/Library/Keychains/login.keychain-db" -t identities -f pkcs12 -P "$p12password" -o "$p12"

password=$(openssl rand -hex 24)
(umask 077; echo "$password" > "$passfile")
security create-keychain -p "$password" "$keychain"
# no -t and no -l: it stays unlocked until logout, not only a few minutes or until sleep
security set-keychain-settings "$keychain"
security unlock-keychain -p "$password" "$keychain"
security import "$p12" -k "$keychain" -P "$p12password" -T /usr/bin/codesign -T /usr/bin/security
# the export takes every identity of the login keychain; only the development one stays
security find-identity "$keychain" | awk '/^ *[0-9]+\)/ && !/"Apple Development: / { print $2 }' | sort -u |
  while read -r hash; do security delete-identity -Z "$hash" "$keychain"; done
# lets codesign use the key without asking
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$password" "$keychain" > /dev/null

# the existing search list, paths with spaces too, with the new keychain added
existing=()
while read -r path; do existing+=("$path"); done < <(security list-keychains -d user | sed 's/^ *"//; s/"$//')
security list-keychains -d user -s "$keychain" "${existing[@]}"
security find-identity -v -p codesigning "$keychain"
