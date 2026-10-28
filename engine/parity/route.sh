#!/bin/sh
# Router parity: answers a query set with the Java reference (RouteReference on BRouter 1.7.10) and with
# richi-engine, and compares every answer byte for byte; also compares the number formats of the output
# (FormatParity.java against router/examples/format_parity.rs). With RICHIROUTE_RULES (the prepared rule
# file) both apply the local rules, and the reference is the planner's server: RICHIROUTE_RULES_JAR (the
# local-rules jar) ahead of the bundle's jar.
#   parity/route.sh            both checks
#   parity/route.sh routes     the routes only
#   parity/route.sh formats    the number formats only
set -eu
engine=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
app="$engine/.."
java_home="${RICHIROUTE_JAVA_HOME:-$app/.cache/runtime/java}"
jar="${RICHIROUTE_BROUTER_JAR:-$app/../richiroute-ubuntu-benchmark/brouter.jar}"
segments="${RICHIROUTE_SEGMENTS:-$app/../richiroute-ubuntu-benchmark/data}"
profiles="${RICHIROUTE_PROFILES:-$app/experiments/routing/.local/local-routing-rules/profiles}"
rules="${RICHIROUTE_ROUTING_RULES:-$app/src/config/routing-rules.generated.json}"
rules_source="${RICHIROUTE_ROUTING_RULES_SOURCE:-$app/config/routing-rules.json}"
[ -f "$rules_source" ] || rules_source=""
search="${RICHIROUTE_ROUTING_SEARCH:-$app/src/config/routing-search.json}"
node="${RICHIROUTE_NODE:-$app/.cache/runtime/node/bin/node}"
threads="${RICHIROUTE_PARITY_THREADS:-6}"
classes="$engine/target/parity/classes"
out="$engine/target/parity/route"
modes="${*:-routes formats}"

for f in "$jar" "$java_home/bin/java" "$node"; do
  [ -e "$f" ] || { echo "route parity skipped: $f is missing"; exit 0; }
done
mkdir -p "$out"
[ -d "$classes/pristine" ] && [ "$classes/router/RouteReference.class" -nt "$engine/parity/java/router/RouteReference.java" ] ||
  "$engine/parity/build-reference.sh"
base="$classes/pristine"
[ -n "${RICHIROUTE_RULES:-}" ] && base="${RICHIROUTE_RULES_JAR:-$app/experiments/routing/.local/brouter-local-rules/brouter-local-rules.jar}"
classpath="$base:$jar:$classes/router"
cd "$engine"
export PATH="$app/.cache/runtime/rust/bin:$PATH" CARGO_HOME="${CARGO_HOME:-$app/.cache/cargo}"
release="${CARGO_TARGET_DIR:-$engine/target}/release"
status=0

case " $modes " in *" formats "*)
  "$java_home/bin/javac" -cp "$classes/pristine:$jar" -d "$classes/router" parity/java/router/FormatParity.java
  cargo build --quiet --release -p brouter-router --example format_parity
  "$java_home/bin/java" -cp "$classpath" FormatParity "${RICHIROUTE_PARITY_COUNT:-1000000}" > "$out/formats.java.txt"
  "$release/examples/format_parity" < "$out/formats.java.txt" > "$out/formats.rust.txt"
  lines=$(wc -l < "$out/formats.java.txt")
  if cmp -s "$out/formats.java.txt" "$out/formats.rust.txt"; then
    echo "formats: $lines lines identical"
  else
    echo "formats: DIFFERENT (first lines below; full files in $out)"
    diff "$out/formats.java.txt" "$out/formats.rust.txt" | head -10
    status=1
  fi
esac

case " $modes " in *" routes "*)
  if [ ! -d "$segments" ] || [ ! -f "$profiles/lookups.dat" ] || [ ! -f "$rules" ] || [ ! -f "$search" ]; then
    echo "route parity skipped: segments, profiles or routing rules missing"
  else
    cargo build --quiet --release -p richi-engine
    "$node" parity/route.mjs queries "$rules" "$search" "$rules_source" > "$out/queries.txt"
    "$java_home/bin/java" -Xmx2g ${RICHIROUTE_RULES:+"-Drichiroute.rules=$RICHIROUTE_RULES"} -cp "$classpath" RouteReference "$segments" "$profiles" "$threads" < "$out/queries.txt" > "$out/java.jsonl"
    "$release/richi-engine" lines "$segments" "$profiles" "$threads" < "$out/queries.txt" > "$out/rust.jsonl"
    "$node" parity/route.mjs compare "$out/queries.txt" "$out/java.jsonl" "$out/rust.jsonl" || status=1
  fi
esac
exit $status
