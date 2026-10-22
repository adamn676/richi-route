#!/bin/sh
set -eu

# Read RD5 data from Linux storage instead of crossing the Windows bind mount.
mkdir -p /tmp/richiroute-segments
rm -f /tmp/richiroute-segments/*.rd5
cp /work/.local/data/*.rd5 /tmp/richiroute-segments/
exec "$@"
