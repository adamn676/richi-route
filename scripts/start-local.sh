#!/bin/sh
set -eu

app_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
bundle_dir="$app_dir/../richiroute-ubuntu-benchmark"
node_bin="$app_dir/.cache/runtime/node/bin/node"
java_bin="$app_dir/.cache/runtime/java/bin/java"
rust_dir="$app_dir/.cache/runtime/rust/bin"
engine_dir="$app_dir/engine"
rules_dir="$app_dir/experiments/routing/.local/local-routing-rules"
log_dir="$app_dir/experiments/routing/.local"
# Vite ignores .env files; local settings such as VITE_GOOGLE_MAPS_EMBED_KEY come from app/.env.local instead.
if [ -f "$app_dir/.env.local" ]; then set -a; . "$app_dir/.env.local"; set +a; fi

if [ ! -f "$bundle_dir/manifest.json" ] || [ ! -f "$bundle_dir/benchmark.mjs" ]; then
  echo 'The verified routing bundle is missing. Place richiroute-ubuntu-benchmark/ next to this checkout; see docs/local-development.md.' >&2
  exit 1
fi
if [ ! -x "$node_bin" ] || [ ! -x "$java_bin" ] || [ ! -x "$rust_dir/cargo" ]; then
  echo 'The current native runtimes are missing. Run node scripts/setup-native.mjs first; see docs/local-development.md.' >&2
  exit 1
fi
if [ ! -f "$app_dir/node_modules/vite/bin/vite.js" ]; then
  echo 'Install the app dependencies with npm ci from the app directory first.' >&2
  exit 1
fi
if [ ! -f "$app_dir/.cache/services/photon/europe/richiroute-search.json" ] || [ ! -f "$app_dir/.cache/maps/richiroute-maps.json" ]; then
  echo 'Local European search or maps are missing. Run npm run search:setup and npm run maps:setup first.' >&2
  exit 1
fi
if [ ! -f "$app_dir/.cache/imagery/ready.json" ]; then
  echo 'European imagery is missing. Run npm run imagery:setup first.' >&2
  exit 1
fi

"$node_bin" "$bundle_dir/benchmark.mjs" verify
PATH="$rust_dir:$PATH" CARGO_HOME="$app_dir/.cache/cargo" "$rust_dir/cargo" build --release \
  --manifest-path "$engine_dir/Cargo.toml" --target-dir "$engine_dir/target" -p richi-engine
"$node_bin" "$app_dir/scripts/prepare-routing-rules.mjs"
"$node_bin" --input-type=module - <<'JS'
import net from 'node:net';
for (const port of [17777, 2322, 8088, 5173]) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', error => reject(new Error(`Cannot use 127.0.0.1:${port}: ${error.code}`, { cause: error })));
    server.listen(port, '127.0.0.1', () => server.close(resolve));
  });
}
JS

mkdir -p "$log_dir"
router_pid=''
web_pid=''
search_pid=''
maps_pid=''
cleanup() {
  trap - EXIT INT TERM
  if [ -n "$web_pid" ]; then kill "$web_pid" 2>/dev/null || true; fi
  if [ -n "$router_pid" ]; then kill "$router_pid" 2>/dev/null || true; fi
  if [ -n "$search_pid" ]; then kill "$search_pid" 2>/dev/null || true; fi
  if [ -n "$maps_pid" ]; then kill "$maps_pid" 2>/dev/null || true; fi
  if [ -n "$web_pid" ]; then wait "$web_pid" 2>/dev/null || true; fi
  if [ -n "$router_pid" ]; then wait "$router_pid" 2>/dev/null || true; fi
  if [ -n "$search_pid" ]; then wait "$search_pid" 2>/dev/null || true; fi
  if [ -n "$maps_pid" ]; then wait "$maps_pid" 2>/dev/null || true; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

RICHIROUTE_RULES="$rules_dir/rules.tsv" "$engine_dir/target/release/richi-engine" serve \
  "$bundle_dir/data" "$rules_dir/profiles" 17777 6 127.0.0.1 > "$log_dir/native-routing.log" 2>&1 &
router_pid=$!
"$node_bin" "$app_dir/scripts/start-search.mjs" > "$log_dir/native-search.log" 2>&1 &
search_pid=$!
"$node_bin" "$app_dir/scripts/start-maps.mjs" > "$log_dir/native-maps.log" 2>&1 &
maps_pid=$!

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
throw new Error('Routing did not start. Check experiments/routing/.local/native-routing.log.');
JS

"$node_bin" --input-type=module - <<'JS'
import { setTimeout as delay } from 'node:timers/promises';
for (const [service, url] of [
  ['maps', 'http://127.0.0.1:8088/style.json'],
  ['search', 'http://127.0.0.1:2322/api/?q=Graz&limit=1'],
]) {
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      await response.text();
      if (response.ok) { ready = true; break; }
    } catch {}
    await delay(500);
  }
  if (!ready) throw new Error(`Local ${service} did not start. Check experiments/routing/.local/native-${service}.log.`);
}
JS

cd "$app_dir"
"$node_bin" node_modules/vite/bin/vite.js "$@" &
web_pid=$!
wait "$web_pid"
