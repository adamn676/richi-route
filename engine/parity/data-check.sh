#!/bin/sh
# Data-layer parity (util, codec, mapaccess): runs parity/java/data/DataDump.java against the reference
# classes and mapaccess/examples/data_parity.rs, and compares their output byte for byte.
#
# Usage: parity/data-check.sh [mode...] [full]
#   modes: heap ruler decode decode-mc match decode-real (default: all)
# Paths: RICHIROUTE_SEGMENTS, RICHIROUTE_PROFILES, RICHIROUTE_JAVA_HOME, RICHIROUTE_BROUTER_JAR.
set -eu
engine=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
app="$engine/.."
java_home="${RICHIROUTE_JAVA_HOME:-$app/.cache/runtime/java}"
jar="${RICHIROUTE_BROUTER_JAR:-$app/../richiroute-ubuntu-benchmark/brouter.jar}"
segments="${RICHIROUTE_SEGMENTS:-$app/../richiroute-ubuntu-benchmark/data}"
profiles="${RICHIROUTE_PROFILES:-$app/experiments/routing/.local/local-routing-rules/profiles}"
classes="$engine/target/parity/classes"
out="$engine/target/parity/data"

modes=""
full=""
for arg in "$@"; do
  if [ "$arg" = full ]; then full=full; else modes="$modes $arg"; fi
done
[ -n "$modes" ] || modes="heap ruler decode decode-mc match decode-real"

if [ ! -d "$classes/pristine" ]; then
  "$engine/parity/build-reference.sh"
fi
# The test-double way context must come before the reference classes (see parity/README.md).
rm -rf "$classes/data-shadow" "$classes/data"
mkdir -p "$classes/data-shadow" "$classes/data" "$out"
"$java_home/bin/javac" -nowarn -cp "$classes/pristine:$jar" -d "$classes/data-shadow" \
  "$engine/parity/java/data/shadow/btools/expressions/BExpressionContextWay.java"
"$java_home/bin/javac" -nowarn -cp "$classes/data-shadow:$classes/pristine:$jar" -d "$classes/data" \
  "$engine/parity/java/data/DataDump.java" "$engine/parity/java/data/CheapRulerTable.java"
cp="$classes/data-shadow:$classes/pristine:$jar:$classes/data"

export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$engine/target/data}"
case "$CARGO_TARGET_DIR" in /*) ;; *) CARGO_TARGET_DIR="$engine/$CARGO_TARGET_DIR" ;; esac
(cd "$engine" && cargo build --quiet --release --example data_parity)
rust="$CARGO_TARGET_DIR/release/examples/data_parity"

# The embedded CheapRuler cosines must still be what Java computes.
"$java_home/bin/java" -cp "$cp" CheapRulerTable | cmp -s - "$engine/util/src/cheap_ruler_table.rs" \
  || { echo "util/src/cheap_ruler_table.rs differs from CheapRulerTable output"; exit 1; }

status=0
for mode in $modes; do
  # decode-real runs the real way context, so the test double must stay off its classpath
  mode_cp="$cp"
  case "$mode" in
    heap|ruler) args="$mode" ;;
    decode-real) args="$mode $segments $profiles/richi-local-v1.brf $full"; mode_cp="$classes/pristine:$jar:$classes/data" ;;
    *) args="$mode $segments $profiles/lookups.dat $full" ;;
  esac
  if [ "$mode" != heap ] && [ "$mode" != ruler ] \
    && { [ ! -f "$segments/E10_N45.rd5" ] || [ ! -f "$profiles/lookups.dat" ]; }; then
    echo "$mode: skipped, segments or profiles missing ($segments, $profiles)"
    continue
  fi
  "$java_home/bin/java" -cp "$mode_cp" DataDump $args > "$out/$mode.java.txt"
  "$rust" $args > "$out/$mode.rust.txt"
  if cmp -s "$out/$mode.java.txt" "$out/$mode.rust.txt"; then
    echo "$mode: identical ($(grep -c '^D ' "$out/$mode.java.txt") sections; $(tail -n 1 "$out/$mode.java.txt"))"
  else
    echo "$mode: DIFFERENT, see $out/$mode.java.txt and $out/$mode.rust.txt"
    status=1
  fi
done
exit $status
