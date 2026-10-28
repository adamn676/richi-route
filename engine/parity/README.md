# Parity checks

Each layer has a Java dump tool, run against the reference classes, and a Rust counterpart. The two
must print the same text. Run the commands from `app/engine/` with the environment from `PORTING.md`.

## Data layer (util, codec, mapaccess)

```sh
parity/data-check.sh              # all modes; add "full" to print every section instead of a sample
parity/data-check.sh decode match # selected modes
```

The script compiles `parity/java/data/` into `target/parity/classes/data*`. It builds the Rust side
(`mapaccess/examples/data_parity.rs`, release), runs both and compares the outputs byte for byte. The
outputs go to `target/parity/data/<mode>.{java,rust}.txt`. It also checks that
`util/src/cheap_ruler_table.rs` is still what `CheapRulerTable.java` prints. Paths come from
`RICHIROUTE_SEGMENTS`, `RICHIROUTE_PROFILES`, `RICHIROUTE_JAVA_HOME` and `RICHIROUTE_BROUTER_JAR`, with
the defaults from `PORTING.md`. Modes that need the segments are skipped when they are missing.

| Mode | What it compares |
| --- | --- |
| `heap` | `SortedHeap`: 36,000 random adds, pops and `getExtract`s, with many equal keys; the popped sequence. |
| `ruler` | `CheapRuler` scale cache and distances, `CheapAngleMeter` angles and directions (fdlibm `atan2`), `calcDistance`. |
| `decode` | 270 positions (220 random over both segment files, 25 each around Graz and Vienna), loaded through `NodesCache` with direct weaving as `RoutingEngine` does. Per position, it dumps everything reachable from the hollow-node index: each node (position, elevation, visit id, description, turn restrictions) and its link chain in order (target, direction, own-link reuse, way description, geometry and decoded transfer nodes). It also covers the index's iteration order, `nodesCreated`, `getElevationType`, `hasHollowLinkTargets` and router-style link holders with one-sided unlinks. Then come the memory checks (`isInMemoryBounds`, `collectOutreachers`, `canEscape`), the graph after them, `getStartNode` on a fresh cache, and `formatStatus`. Caches are reused between positions, and cleanup modes 0/1/2 and the detailed flag alternate. |
| `decode-mc` | The same without direct weaving (`MicroCache2` and `parseNodeBody2`), on 78 positions. It parses whole cells (so `canEscape` meets real islands) and uses a small `maxmem` on half of them, so ghost cleaning and garbage collection run. |
| `decode-real` | The `decode` dump on 12 positions (Graz, Vienna, random) with the planner's profile `richi-local-v1.brf`: pristine `BExpressionContextWay` loaded via `ProfileCache` (classpath `pristine:brouter.jar:data`, without the test double) against the Rust `brouter-expressions` profile. This is the only mode that runs the real profile through the decoders. |
| `match` | `matchWaypointsToNodes` for 542 waypoints in groups of 1-3, with range 250 and the round-trip mode's -60000. It includes beeline (direct) waypoints, island node pairs (re-matched after freezing a pair), points outside the data, at its edges and in the sea. For each waypoint it dumps the cross point, node1/node2, radius, directions and the `wayNearest` list. |

Each section ends with `D <section> lines=<n> fnv=<digest>` over its canonical text. Sections are
printed in full for a sample (every 20th position, every 10th group) unless `full` is given. On a
mismatch, rerun the mode with `full` and diff the two files.

**Test validator.** `NodesCache` takes the final class `BExpressionContextWay`, so the deterministic
validator these modes need is a test double under that name,
`parity/java/data/shadow/btools/expressions/BExpressionContextWay.java`. The classpath is
`data-shadow:pristine:brouter.jar:data`. No util, codec or mapaccess class is shadowed. The Rust mirror
is `TestValidator` in `data_parity.rs`; keep both identical. Its access type (0, 1 or 2, with 1 only
when decoding is forbidden) and start-way flag derive from the description's CRC. Lookups with
`idx % 5 == 3` count as unused, and descriptions are interned by content.

`cargo test` runs the `heap` and `ruler` sections of `data_parity.rs` (an example built as a test) and
checks their digests against the values Java printed. Those two checks therefore need no Java.

## Profile language (expressions)

```sh
parity/build-reference.sh   # once: the pristine 1.7.10 classes
parity/expressions.sh       # everything below, about 2.5 minutes on 16 cores
```

The script compiles `parity/java/expressions/ExpressionsParity.java` against
`pristine:brouter.jar` into `target/parity/classes/expressions`. It builds the Rust side
(`expressions/examples/parity_dump.rs`, release), runs both on the same inputs and compares the
outputs byte for byte in `target/parity/expressions/<label>.{java,rust}.txt`. Matching dumps over
100,000 lines are deleted unless `RICHIROUTE_PARITY_KEEP=1`. Paths come from `RICHIROUTE_PROFILES`,
`RICHIROUTE_BROUTER_SRC`, `RICHIROUTE_ROUTING_RULES` (default `app/src/config/routing-rules.generated.json`),
`RICHIROUTE_JAVA_HOME` and `RICHIROUTE_BROUTER_JAR`, with the defaults from `PORTING.md`; the script
skips when data is missing. `RICHIROUTE_PARITY_COUNT` (default 50,000) sets the number of random
descriptions per context, `RICHIROUTE_PARITY_FLOATS=0` skips the exhaustive float sweep.

| Label | What it compares |
| --- | --- |
| `numbers` | `Float.parseFloat` on `numbers.txt` (edge cases, hex floats, error messages), `Float.toString` and its round trip on 221,000 values `(val - 1000) / 100f` (numeric tag values) and 300,000 random bit patterns, and `parseFloat` on 200,000 random decimal strings. |
| `floats` | `Float.toString` of all 2^32 bit patterns, as FNV-1a digests per 2^24 patterns. |
| `dump-<profile>` | Lookup table as read (values, aliases), parse results of the way and node context (node count after folding, expressions, variables, read-only globals with values, defined build-in variables, used lookups, `noStartWay` list, model class), then the evaluations below. The planner's profiles run with the planner's overrides (`pass1coefficient=2`, `pass2coefficient=0.7`, the four `richiroute_rules_N` from the routing rules), the standard profiles without. |
| `globals-<profile>` | The parse results only, with the other override set. |
| `dump-soft_test`, `dump-profile_test`, `dump-features*` | BRouter's own test profiles and `profiles/features.brf` on `lookups_test.dat`, whose `*` values give numeric tags: `v:` lookups, `noStartWay`, `xor`, `divide`, a variable read before its assignment (history-dependent), injected key values, a kinematic model. |
| `broken-*` | Error messages: `profiles/broken/*.brf` (parse errors with line numbers, runtime `div by zero` and `v:` index errors), a bad override value, a missing profile, a profile against the wrong lookup table. |

Descriptions come from `gen`, which encodes them with the Java context's own encoder into
`target/parity/expressions/desc*/{way,node}.txt`: every single key=value of the table, then seeded
random combinations (highway mostly set, up to 11 more tags weighted 8:1 towards tags some profile
uses, 2% numeric values, every tenth a repeat). Per way description the dump has, for both directions,
the cached way context's build-in variables (as `f32` bits), the full variable set of a cache-less way
context and the key-value description (`W`), then `accessType`, `checkStartWay` and whether `unify`
returns the cached array for this and an older description (`A`), and the decoded lookup values with
the `v:` number of each (`D`). Per node description: the way context first evaluates a way
description, then for both `nodeaccessgranted` values the node's build-in variables, variables and
key-value description (`N`), and the decode check (`E`). The way cache holds 2048 descriptions, so the
LRU evicts all the time.

Deliberate difference: Java's `LruMap` throws a `NullPointerException` when its capacity is 1 (only
reachable through BRouter's `disableExpressionCache` debug switch); the port keeps working.

## Router (router, cli)

```sh
cargo build --release -p richi-engine   # target/release/richi-engine, which loops.mjs runs
node parity/loops.mjs rust              # the planner's loop suggestions: 20 starts × 36 round trips, 6 workers
node parity/loops.mjs compare java rust # every answer's sha256 against the recorded Java baseline
parity/route.sh                         # routes and number formats, Java against Rust, byte for byte
parity/route.sh routes                  # (or: formats) one part only
```

Use the Node at `../.cache/runtime/node/bin/node`. `richi-engine lines <segmentDir> <profileDir> <threads>`
speaks the line protocol of `parity/java/router/RouteReference.java` (BRouter's server without the socket):
`id<TAB>query` lines in, one JSON line `{"id","ms","error"|"geojson"}` out per request, in completion order.

**Loops.** `loops.mjs` drives the planner's own loop-suggestion code against an engine process and records
every answer in `target/parity/loops/<engine>.json`; `compare` counts different answers and suggestions and
prints the time per start. `java.json` is the baseline of pristine 1.7.10; do not overwrite it. To time
Java again under the current load, record under another name: `node parity/loops.mjs java --as java-now`,
then `compare java-now rust`.

**Routes.** `route.sh routes` builds the query set with `parity/route.mjs` (as the planner's route service
builds queries, with the real `profile:` parameters from `RICHIROUTE_ROUTING_RULES` and
`RICHIROUTE_ROUTING_SEARCH`, default `app/src/config/routing-search.json`), answers it with
`RouteReference` (classpath `pristine:brouter.jar:router`) and with `richi-engine`, both with
`RICHIROUTE_PARITY_THREADS` workers (default 6), and compares the full GeoJSON or error text per query.
For the first differences it prints the query and the first differing line. Outputs go to
`target/parity/route/`. The set covers:

| Group | What |
| --- | --- |
| `roundtrip` | Round trips like the loop suggestions: 15 starts (towns, Alps, Pannonia), radii 2.5–16 km, five directions. |
| `roundtrip-points`, `-sameway`, `-profiles`, `-defaults` | 2–25 circle points (out of range falls back to 5), `allowSamewayback`, the other two profiles, profiles without the planner's parameters. |
| `ab` | A to B with all three profiles: short legs in town, 30–140 km legs, one across two segment files. |
| `ab-via`, `ab-snap` | 3 and 4 waypoints; legs from a point to itself (the planner's snap) and between points on one way. |
| `ab-params` | `alternativeidx` 1–3 (reference-track penalties), `heading`, `allowSamewayback`, named and `m` waypoints, `showspeed`, `inverseRouting`, an absolute profile name, nogo and poi parameters without any nogo or poi. |
| `errors` | Missing data (`datafile … not found`), the sea (`…-position not mapped in existing datafile`), and BRouter's exceptions for bad parameters, profiles and URL escapes (`exception: …`). |

Island detection (`target island detected for section …`) and the restart after a routing island come up
in the round trips and the loops.

**Formats.** `route.sh formats` compiles `parity/java/router/FormatParity.java`, which prints
`Double.toString` for every elevation (`selev / 4.`) and for random, scientific and subnormal doubles,
`DecimalFormat("0.###")` for random floats (FormatJson's `times`), `formatILon`/`formatILat` and the
track message's energy and time formats. `router/examples/format_parity.rs` reads that dump and prints it
again with the Rust formatting; the two files must be identical. `RICHIROUTE_PARITY_COUNT` (default
1,000,000) sets the sample size.

`cargo test` runs unit tests that need no data, including Java values of `Math.sin`, `Math.cos` and
`Math.exp` where the platform's functions differ (HotSpot's intrinsics, ported in `router/src/libm.rs`),
and `router/tests/routes.rs`, which routes four requests through the library and checks digests of the
Java answers (skipped without the segments and profiles).

Not covered, because the port reports them as unsupported (`not supported by this engine: …`) instead of
answering like Java: engine modes 2 and 3, round trips without `direction` (BRouter picks a random one),
turn instructions (`timode`/`turnInstructionMode` > 0), beeline segments (`d` waypoints, `straight`,
`add_beeline`), nogos and pois (when the parameters hold any), kinematic models, `correctMisplacedViaPoints`
and `continueStraight`. The output is always GeoJSON, whatever `format` asks for, as in `RouteReference`.
