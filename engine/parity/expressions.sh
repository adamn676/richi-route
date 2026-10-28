#!/bin/sh
# Parity check of the profile language (btools.expressions): parity/java/expressions/ExpressionsParity.java
# on the BRouter 1.7.10 reference against expressions/examples/parity_dump.rs. Every output must be
# identical. Outputs go to target/parity/expressions/ (large dumps are deleted when they match unless
# RICHIROUTE_PARITY_KEEP=1). Run parity/build-reference.sh once before.
set -eu
engine=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
app="$engine/.."
java_home="${RICHIROUTE_JAVA_HOME:-$app/.cache/runtime/java}"
jar="${RICHIROUTE_BROUTER_JAR:-$app/../richiroute-ubuntu-benchmark/brouter.jar}"
src="${RICHIROUTE_BROUTER_SRC:-$app/.cache/brouter-src/brouter-1.7.10}"
profiles="${RICHIROUTE_PROFILES:-$app/experiments/routing/.local/local-routing-rules/profiles}"
rules="${RICHIROUTE_ROUTING_RULES:-$app/src/config/routing-rules.generated.json}"
count="${RICHIROUTE_PARITY_COUNT:-50000}"   # random descriptions per context
hash_size=2048                               # small way cache, so the LRU evicts all the time
                                             # (Java's LruMap throws at size 1; the port does not)
classes="$engine/target/parity/classes"
out="$engine/target/parity/expressions"
tools="$engine/parity/java/expressions"
tests="$src/brouter-expressions/src/test/resources"

for f in "$jar" "$profiles/lookups.dat" "$src/misc/profiles2/lookups.dat" "$tests/lookups_test.dat" "$rules"; do
  [ -e "$f" ] || { echo "skipped: missing $f (data paths: engine/PORTING.md)"; exit 0; }
done
[ -d "$classes/pristine" ] || { echo "run parity/build-reference.sh first"; exit 1; }

mkdir -p "$classes/expressions" "$out"
"$java_home/bin/javac" -nowarn -cp "$classes/pristine:$jar" -d "$classes/expressions" "$tools/ExpressionsParity.java"
(cd "$engine" && cargo build --quiet --release -p brouter-expressions --example parity_dump)
case "${CARGO_TARGET_DIR:-target}" in
  /*) rust="$CARGO_TARGET_DIR/release/examples/parity_dump" ;;
  *) rust="$engine/${CARGO_TARGET_DIR:-target}/release/examples/parity_dump" ;;
esac

java_tool() { "$java_home/bin/java" -Xmx2g -cp "$classes/pristine:$jar:$classes/expressions" ExpressionsParity "$@"; }

failures=0 compared=0 evaluations=0
compare() { # LABEL ARGS...: runs both tools with ARGS and compares their output
  label=$1
  shift
  java_tool "$@" > "$out/$label.java.txt"
  "$rust" "$@" > "$out/$label.rust.txt"
  compared=$((compared + 1))
  lines=$(wc -l < "$out/$label.java.txt")
  evals=$(grep -c '^[WN] ' "$out/$label.java.txt" || true)
  evaluations=$((evaluations + evals))
  if cmp -s "$out/$label.java.txt" "$out/$label.rust.txt"; then
    printf 'same     %-44s %7d lines %7d W/N%s\n' "$label" "$lines" "$evals" "$(grep -m1 '^error\|^evalerror' "$out/$label.java.txt" | sed 's/^/  /' || true)"
    if [ "${RICHIROUTE_PARITY_KEEP:-0}" != 1 ] && [ "$lines" -gt 100000 ]; then rm "$out/$label.java.txt" "$out/$label.rust.txt"; fi
  else
    printf 'DIFFERS  %s: diff %s %s\n' "$label" "$out/$label.java.txt" "$out/$label.rust.txt"
    failures=$((failures + 1))
  fi
}

# the planner's request overrides: profile:pass1coefficient, profile:pass2coefficient, local rules
planner="pass1coefficient=2 pass2coefficient=0.7 $(grep -o '"richiroute_rules_[0-9]*": *"[^"]*"' "$rules" | sed 's/"\([^"]*\)": *"\([^"]*\)"/\1=\2/' | tr '\n' ' ')"
echo "planner overrides: $planner"

compare numbers numbers "$tools/numbers.txt"
if [ "${RICHIROUTE_PARITY_FLOATS:-1}" = 1 ]; then compare floats floats; fi

# descriptions: every single key=value, then random combinations weighted towards the profiles' tags
java_tool gen "$profiles/lookups.dat" "$out/desc" 1 "$count" "$profiles"/*.brf "$src"/misc/profiles2/*.brf
java_tool gen "$tests/lookups_test.dat" "$out/desc-test" 2 "$count" "$tools/profiles/features.brf" "$tests"/*.brf
# the standard profiles use the planner's table, or their own when it differs
std_lookups="$profiles/lookups.dat" std_desc="$out/desc"
if ! cmp -s "$profiles/lookups.dat" "$src/misc/profiles2/lookups.dat"; then
  std_lookups="$src/misc/profiles2/lookups.dat" std_desc="$out/desc-std"
  java_tool gen "$std_lookups" "$std_desc" 3 "$count" "$src"/misc/profiles2/*.brf
fi
echo "descriptions: way $(wc -l < "$out/desc/way.txt"), node $(wc -l < "$out/desc/node.txt") (lookups_test.dat: way $(wc -l < "$out/desc-test/way.txt"), node $(wc -l < "$out/desc-test/node.txt"))"

for p in "$profiles"/*.brf; do
  name=$(basename "$p" .brf)
  # shellcheck disable=SC2086
  compare "dump-$name" dump "$profiles/lookups.dat" "$p" "$out/desc" "$hash_size" $planner
  compare "globals-$name" globals "$profiles/lookups.dat" "$p"
done
for p in "$src"/misc/profiles2/*.brf; do
  name=$(basename "$p" .brf)
  compare "dump-$name" dump "$std_lookups" "$p" "$std_desc" "$hash_size"
  # shellcheck disable=SC2086
  compare "globals-$name-planner" globals "$std_lookups" "$p" $planner
done

# the reference's own test profiles and the feature profile, with numeric (*) lookup values
compare dump-soft_test dump "$tests/lookups_test.dat" "$tests/soft_test.brf" "$out/desc-test" "$hash_size"
compare dump-profile_test dump "$tests/lookups_test.dat" "$tests/profile_test.brf" "$out/desc-test" "$hash_size" global_inject1=7 global_inject2=9
compare dump-features dump "$tests/lookups_test.dat" "$tools/profiles/features.brf" "$out/desc-test" "$hash_size"
compare dump-features-overrides dump "$tests/lookups_test.dat" "$tools/profiles/features.brf" "$out/desc-test" "$hash_size" \
  injected_global=7 processUnusedTags=1 not_in_profile=-3.5e2
compare dump-features-nostart dump "$tests/lookups_test.dat" "$tools/profiles/features.brf" "$out/desc-test" "$hash_size" check_start_way=0

# error messages
for p in "$tools"/profiles/broken/*.brf; do
  compare "broken-$(basename "$p" .brf)" dump "$profiles/lookups.dat" "$p" "$out/desc" "$hash_size"
done
compare broken-override globals "$profiles/lookups.dat" "$tools/profiles/features.brf" twice=abc
compare broken-missing-profile globals "$profiles/lookups.dat" "$tools/profiles/missing.brf"
compare broken-lookups-for-standard globals "$tests/lookups_test.dat" "$src/misc/profiles2/trekking.brf"

echo "compared $compared outputs with $evaluations W/N evaluation lines: $failures differ"
[ "$failures" -eq 0 ]
