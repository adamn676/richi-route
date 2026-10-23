#!/bin/sh
set -eu

app_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
bundle_dir="$app_dir/../richiroute-ubuntu-benchmark"
node_bin="$app_dir/.cache/runtime/node/bin/node"
java_bin="$app_dir/.cache/runtime/java/bin/java"
rules_jar="$app_dir/experiments/routing/.local/brouter-local-rules/brouter-local-rules.jar"
rules_dir="$app_dir/experiments/routing/.local/local-routing-rules"
log_dir="$app_dir/experiments/routing/.local"

if [ ! -f "$bundle_dir/manifest.json" ] || [ ! -f "$bundle_dir/benchmark.mjs" ]; then
  echo 'The verified routing bundle is missing. Place richiroute-ubuntu-benchmark/ next to this checkout; see docs/local-development.md.' >&2
  exit 1
fi
if [ ! -x "$node_bin" ] || [ ! -x "$java_bin" ]; then
  echo 'The current native runtimes are missing. Run node scripts/setup-native.mjs first; see docs/local-development.md.' >&2
  exit 1
fi
if [ ! -f "$app_dir/node_modules/vite/bin/vite.js" ]; then
  echo 'Install the app dependencies with npm ci from the app directory first.' >&2
  exit 1
fi

"$node_bin" "$bundle_dir/benchmark.mjs" verify
"$node_bin" "$app_dir/experiments/routing/brouter-patch/build-local-rules.mjs" --verify
"$node_bin" "$app_dir/scripts/prepare-routing-rules.mjs"
"$node_bin" --input-type=module - <<'JS'
import net from 'node:net';
for (const port of [17777, 5173]) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', error => reject(new Error(`Cannot use 127.0.0.1:${port}: ${error.code}`, { cause: error })));
    server.listen(port, '127.0.0.1', () => server.close(resolve));
  });
}
JS

mkdir -p "$bundle_dir/customprofiles" "$log_dir"
router_pid=''
web_pid=''
cleanup() {
  trap - EXIT INT TERM
  if [ -n "$web_pid" ]; then kill "$web_pid" 2>/dev/null || true; fi
  if [ -n "$router_pid" ]; then kill "$router_pid" 2>/dev/null || true; fi
  if [ -n "$web_pid" ]; then wait "$web_pid" 2>/dev/null || true; fi
  if [ -n "$router_pid" ]; then wait "$router_pid" 2>/dev/null || true; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

"$java_bin" -Xmx1g -XX:+UseParallelGC -DmaxRunningTime=60 -Drichiroute.rules="$rules_dir/rules.tsv" -cp "$rules_jar:$bundle_dir/brouter.jar" \
  btools.router.LocalRulesServer "$bundle_dir/data" "$rules_dir/profiles" \
  "$bundle_dir/customprofiles" 17777 6 127.0.0.1 > "$log_dir/native-brouter.log" 2>&1 &
router_pid=$!

"$node_bin" --input-type=module - <<'JS'
import { setTimeout as delay } from 'node:timers/promises';
const params = new URLSearchParams({
  profile: 'richi-local-v1', lonlats: '15.4329,47.075887|15.4329,47.075887',
  format: 'geojson', alternativeidx: '0',
});
for (let attempt = 0; attempt < 30; attempt++) {
  try {
    const response = await fetch(`http://127.0.0.1:17777/brouter?${params}`, { signal: AbortSignal.timeout(1000) });
    await response.text();
    if (response.ok) process.exit(0);
  } catch {}
  await delay(250);
}
throw new Error('Routing did not start. Check experiments/routing/.local/native-brouter.log.');
JS

cd "$app_dir"
"$node_bin" node_modules/vite/bin/vite.js "$@" &
web_pid=$!
wait "$web_pid"
