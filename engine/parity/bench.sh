#!/bin/sh
# Engine benchmark: answers a fixed set of the planner's loop queries with richi-engine, several times,
# and prints the fastest run (with peak RSS where GNU time is installed). With several binaries it runs
# them in turn and checks that they give the same answers.
#   parity/bench.sh                      build the release binary, then run it
#   parity/bench.sh old/richi-engine new/richi-engine    A/B two (or more) builds
# Settings (RICHIROUTE_BENCH_*): see parity/README.md.
set -eu
engine=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
app="$engine/.."
segments="${RICHIROUTE_SEGMENTS:-$app/../richiroute-ubuntu-benchmark/data}"
profiles="${RICHIROUTE_PROFILES:-$app/experiments/routing/.local/local-routing-rules/profiles}"
node="${RICHIROUTE_NODE:-$app/.cache/runtime/node/bin/node}"
runs="${RICHIROUTE_BENCH_RUNS:-3}"
threads="${RICHIROUTE_BENCH_THREADS:-1}"
starts="${RICHIROUTE_BENCH_STARTS:-Graz,Feldbach,St. Pölten}"
baseline="$engine/target/parity/loops/java.json"
out="$engine/target/parity/bench"

[ -f "$baseline" ] || { echo "bench: $baseline missing (node parity/loops.mjs java records it)"; exit 1; }
mkdir -p "$out"
if [ $# -eq 0 ]; then
  export PATH="$app/.cache/runtime/rust/bin:$PATH" CARGO_HOME="${CARGO_HOME:-$app/.cache/cargo}"
  (cd "$engine" && cargo build --quiet --release -p richi-engine)
  set -- "${CARGO_TARGET_DIR:-$engine/target}/release/richi-engine"
fi

count=$("$node" -e '
const [baseline, starts, file] = process.argv.slice(1);
const picked = new Set(starts.split(","));
const lines = [];
for (const start of JSON.parse(require("fs").readFileSync(baseline, "utf8")))
  if (picked.has(start.name)) for (const answer of start.answers) lines.push(`${lines.length}\t${answer.query}`);
require("fs").writeFileSync(file, lines.join("\n") + "\n");
console.log(lines.length);
' "$baseline" "$starts" "$out/queries.txt")
echo "bench: $count queries ($starts), $threads thread(s), best of $runs"

pin=""
[ -n "${RICHIROUTE_BENCH_CPUS:-}" ] && pin="taskset -c $RICHIROUTE_BENCH_CPUS"

timer=""
[ -x /usr/bin/time ] && timer="/usr/bin/time -f %M -o $out/rss.txt"
rm -f "$out"/times.*
for run in $(seq "$runs"); do
  i=0
  for bin in "$@"; do
    i=$((i + 1))
    rm -f "$out/rss.txt"
    began=$(date +%s%N)
    # shellcheck disable=SC2086
    $pin $timer "$bin" lines "$segments" "$profiles" "$threads" ${RICHIROUTE_BENCH_CELL_CACHE_MB:-} \
      < "$out/queries.txt" > "$out/answers.$i.jsonl"
    ms=$(( ($(date +%s%N) - began) / 1000000 ))
    rss=$(cat "$out/rss.txt" 2>/dev/null || echo 0)
    echo "run $run: $bin $ms ms, peak RSS $((rss / 1024)) MB"
    echo "$ms $rss" >> "$out/times.$i"
  done
done

status=0
i=0
for bin in "$@"; do
  i=$((i + 1))
  best=$(sort -n "$out/times.$i" | head -n 1)
  best_ms=${best% *} best_rss=${best#* }
  echo "best: $bin $best_ms ms, peak RSS $((best_rss / 1024)) MB"
  if [ "$i" -gt 1 ]; then
    "$node" -e '
const read = f => new Map(require("fs").readFileSync(f, "utf8").trim().split("\n").map(line => {
  const a = JSON.parse(line); return [a.id, a.geojson ?? `error: ${a.error}`]; }));
const [a, b] = process.argv.slice(1).map(read);
const different = [...a.keys()].filter(id => a.get(id) !== b.get(id));
if (different.length) { console.log(`  DIFFERENT answers from the first binary: ${different.length}`); process.exit(1); }
' "$out/answers.1.jsonl" "$out/answers.$i.jsonl" || status=1
  fi
done
exit $status
