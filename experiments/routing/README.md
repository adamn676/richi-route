# Local road-cycling comparison

Current installation and maintenance instructions are in the
[development guide](../../docs/local-development.md). The dated entries below
record experiments and earlier setups; their commands and package versions do
not replace the current guide. Raw results under `.local/` are retained locally
and are not part of the Git checkout.

## Refinement coefficient 1, 28 October 2026

`src/config/routing-search.json` now sends `pass2coefficient=1` instead of `0.7`;
`pass1coefficient` stays `2`. With `0.7`, two long sections stopped with
`memory limit reached`, the native engine's cap of 4,194,304 search paths:
Virgen–Mistelbach, which this guide measured on 22 October before the cap
existed, and Kötschach-Mauthen–Hohenems, whose straight line crosses South Tyrol,
the Vinschgau and the Engadin. A larger memory class (128 to 1024 MB) changed
nothing; a stronger first pass (`3` or `4`) did not help either.

The refinement heads more directly for the destination with `1`. Every way in
the profile costs at least its length (cost factor 1.0 for tertiary roads, with
non-negative penalties), so the coefficient still respects the route costs. All
164 parity requests (round trips, A–B routes, every local rule, error cases)
returned identical geometry and costs on the native engine, 23.8 s → 18.8 s in
total. Single sections, native engine, one request at a time:

| Section | `0.7` | `1` |
| --- | --- | --- |
| Graz–Virgen | 338.8 km, cost 451292, 2.6 s | 338.8 km, cost 451396, 2.2 s |
| Graz–Mistelbach, 252 km | 251.8 km, 2.2 s | identical, 1.9 s |
| Virgen–Mistelbach | memory limit, 4.2 s | 523.3 km, 3.3 s |
| Neusiedl–Styrian shaping point | 182.3 km, 0.9 s | identical, 0.7 s |
| Styrian shaping point–Kötschach | 263.3 km, 1.5 s | identical, 0.9 s |
| Kötschach–Hohenems | memory limit, 5.7 s | 407.8 km, 5.0 s |

Graz–Virgen keeps its length and climbing; its cost is 0.02% higher, the only
difference found. `0.9` gave the same results as `1`, while `0.95` stopped at the
cap on Kötschach–Hohenems: sections this demanding remain close to the cap, and a
stop splits them as before. A changed routing policy recalculates saved legs
when they are opened. A profile change must keep every way at a cost of at least
1 per metre; the bundle check for the base profile says so.

## Configurable local routing rules, 23 October 2026

The native editor now uses `richi-local-v1` and the `local-rules-v1` comparison
preset. Weidweg passages, the Ries bicycle turn and the Thal road preference
are entries in [`config/routing-rules.json`](../../config/routing-rules.json).
Adding another location of these types changes data and generated artifacts;
it requires a service restart, without rebuilding Java. The integration keeps
the existing search settings, runtime, road costs and map tiles.

The same configuration generates engine rules, retained profile tags, browser
notices and a policy digest. Exact graph endpoints and tag guards limit passage
exceptions; turn corrections preserve other restrictions and modes. Indexed
matching avoids scanning every location during routing. Reviewed tile checksums
stop preparation when map data changes. The browser refreshes routes saved under
a changed policy while keeping their geometry visible. A client/server digest
mismatch returns HTTP 400 with a restart message, and retry recovers normally.
See the [rule format and maintenance workflow](brouter-patch/README.md#configurable-local-rules).

### Scale comparison

The final comparison used the previous optimized engine, the three migrated
rules, and 1,000 or 10,000 additional synthetic rules. The additions mix passages,
turns and tiny avoidance circles across the existing E15/N45 tile. All variants
used GraalVM 25, a 1 GB heap, the parallel collector, six workers, search settings
`2`/`0.7`, identical maps and JFR recording. Requests ran sequentially in rotating
variant order, with two warmups followed by four measured runs per route/variant.

| Server request | Previous optimized engine | 3 rules | 1,003 rules | 10,003 rules |
| --- | ---: | ---: | ---: | ---: |
| Graz–Virgen, 339 km | 2773 ms | 2763 ms | 2845 ms | 2851 ms |
| Virgen–Mistelbach, 523 km | 4351 ms | 4307 ms | 4452 ms | 4474 ms |

These are medians, using the average of the middle pair for four samples.
The current three rules are effectively unchanged in speed. At 10,003 rules,
the medians are **2.8% higher** than the previous optimized engine on both routes,
or 3.2%/3.9% above the three-rule configuration. All **48** complete feature
hashes matched after normalizing only the generated profile name. These are
warm server request times, excluding browser rendering and service startup.
The earlier end-to-end browser timings below remain a separate experiment.

The first index traversed the area tree for every candidate segment. A bounded
cache of nearby spatial cells reduced the 10,003-rule medians from 3124/4829 ms
to 2851/4474 ms. Long segments still use the full tree; overlapping-circle order
and waypoint exclusions remain identical to the original calculation. This
fixture measures dispersed locations sharing a few tag patterns. Many unique
guard patterns, large overlapping areas or different route distributions need
their own measurements.

JFR covered the same twelve route requests and readiness check per engine,
including warmups and startup. Weighted cumulative allocation estimates were
13.82 GB for the previous engine, 13.76 GB for three rules and 13.85 GB for
10,003 rules; these are allocation estimates, not live heap sizes. Maximum
observed heap after GC was 676/677/717 MB respectively. Total recorded GC pauses
were 394/391/457 ms, with maximum pauses of 4.5/4.6/43.1 ms. The larger configuration
therefore has a modest memory and pause cost as well as the measured time cost.
The short recording does not establish long-term memory or tail-latency behavior.

The CPU flamegraphs show local-rule frames in 188 of 4,300 execution samples
at 10,003 rules, down from 464 of 4,699 before the spatial cache. Route search,
cost calculations and map decoding remain the main work. Native wait samples
were excluded from CPU conclusions. No thresholded monitor-enter events were
recorded. Raw recordings, `profile-comparison.json`, `cpu-flamegraphs.html`,
`scale-benchmark.json` and the earlier `uncached-index/` run are retained under
`.local/local-routing-rules/`. Reproduce the scale test with `npm run routing:benchmark`.

### Verification

The final native launcher reproduces **51/51** saved full-feature hashes. Java
checks pass **300,039** assertions, including 100,000 randomized indexed-area
comparisons against the original BRouter calculation. Configuration-only engine
tests cover disabling all rules, renamed/directional passages, reverse searches,
mode guards, concurrent profile isolation and the actual HTTP revision error.
The 14 protected editor routes and 12 local edits pass, as do all nine browser
checks, 59 editor and 37 comparison unit tests, and both production builds.
The browser checks include stale-policy refresh, notice deduplication, version
mismatch/retry, draft restoration, GPX export and the production map worker.
An additional fresh-browser check reproduced the saved geometry, elevation and
surface hashes for 339 km, 523 km and the complete 1,131 km loop. All 31,229 loop
vertices reached the map, with no partial initial line. Its single observed
4.74-second drawing time is a smoke-check result, not a new paired speedup claim.

The original benchmark bundle remains checksum verified. Historical presets
and the Docker bicycle-v2 setup still describe the preserved baseline; they
require that engine. The western composite remains an open product target.

## Runtime and search optimization, 22 October 2026

The native Ubuntu editor now uses first-pass guidance `2` and refinement
guidance `0.7`, GraalVM Community 25.4.4.1.1 with its default compiler and parallel
collector, and a verified three-class performance overlay. The heap remains
1 GB and the server has six workers. `weidweg-search-v3` shares the editor's
settings; the v1 and v2 comparison presets retain their earlier values. Road
costs, accepted local bicycle rules, map data and all saved references are unchanged.

Fresh route creation through first complete map drawing, compared with the
previous Java 21 engine and refinement-only `0.7` optimization:

| Route | Previous median (range) | Current median (range) | Reduction |
| --- | ---: | ---: | ---: |
| Graz–Virgen, 338.830 km | 3625 ms (3586–3637) | 2880 ms (2840–2924) | 20.6% |
| Virgen–Mistelbach, 523.295 km | 6641 ms (6624–6812) | 4442 ms (4407–4448) | 33.1% |
| Graz–Virgen–Mistelbach–Graz, 1130.794 km | 7009 ms (7007–7059) | 4647 ms (4643–4697) | 33.7% |

These are paired measurements in Chromium 156 with the same updated frontend
for both variants. Each route/variant gets one warmup and three measured runs,
in alternating order, in an empty isolated context. Every route sends all snaps
and legs: three requests for each single leg, seven for the loop. Both variants
use identical Playwright request interception to reach their local engines.
Background map downloads, application startup and router startup are excluded.
Other build and routing jobs were idle. The host is the Ryzen 7800X3D Ubuntu
workspace with a performance CPU governor.

All 24 builds matched the complete geometry, elevations and surface spans,
sent every coordinate to the map, saved their drafts and displayed no partial
initial line. The loop retains all 31,229 vertices. The report is
`.local/initial-route-speed/browser-max-optimization.json`. Earlier measurements
below remain historical records; their numbers are not mixed into this comparison.

A separate cold-JVM check starts a fresh engine for every sample, with only the
readiness snap before the route. Three trials per variant, alternating order,
gave 3913 → 3341 ms for Graz–Virgen (**14.6%**) and 7005 → 5180 ms for
Virgen–Mistelbach (**26.1%**). Filesystem caches were already warm; service startup
is outside those request times. All 12 complete feature hashes matched.

### What changed and what was rejected

Java Flight Recorder and the exact BRouter 1.7.10 sources identified route
search, way costs, distance checks, decoding and queue work as the main CPU
costs. Native `Net.accept` samples represent a waiting server thread and were
excluded from CPU conclusions. Guidance for both search passes reduced the
work needed before final refinement. A sweep around first-pass `2` found
`1.25`, `1.75`, `2.25`, `2.5`, `3` and `4` slower on the longest test leg.
Single-pass search was also slower. Raising refinement above the accepted
range could change geometry, so the final refinement value remains `0.7`.
See the [upstream search discussion](https://github.com/abrensch/brouter/issues/967).

The runtime was measured independently before combining changes. Default
Graal compilation improved the two long single-leg medians by 6.6–8.2% against
the original Java 21 process; disabling it lost most of that benefit. The
parallel collector also improved the tested workload. A 2 GB heap produced
less than a 1% change, within the noise, so the heap stays at 1 GB.

The final overlay skips distant avoidance-circle calculations, uses equivalent
power-of-two cache indexing, and separates ordinary way costs from the rare
Weidweg exception. See its [source checks and build procedure](brouter-patch/README.md#performance-overlay).
Against otherwise identical fresh Graal/parallel-collector engines, the built
overlay improved medians from 2814 → 2753 ms and 4402 → 4282 ms: **2.2% and
2.7%**, with five measured samples after two warmups. Every paired measured
request was faster. This confirms the gain after combining the changes.

A cached-minimum priority-queue prototype was 2.9–3.6% slower. Two decoder
prototypes helped the older Java runtime in isolation but added no reliable
gain to the final Graal combination. All five patches together slightly
regressed the matched Graal comparison. Those prototypes remain outside the
active build. The individual percentages above are not additive.

Before/after JFR recordings used five requests each for the same 339 km and
523 km routes. Weighted allocation samples estimated 14.13 → 11.52 GB allocated
over that load; this is an estimate of cumulative allocation, not live heap
usage. Recorded GC pauses totalled 409 → 333 ms, with maximum pauses of
8.5 → 4.8 ms. Search and road decoding remain the dominant work. The final
browser profile spent about 90 ms between the last response and the complete
1,131 km map line. Application JavaScript functions were small contributors;
the profile recorded one 70 ms long task. No geometry simplification or loss
of elevation/surface detail was needed.

### Verification and reproduction

The final runtime and built overlay reproduced **51/51** saved full-feature
hashes, including the regional directions, long routes and protected review
corridors. The Java reference checks passed **2.8 million** cache/geometry
cases. The updated app passed all **87 unit checks**, both production builds,
all eight browser checks, the 14 protected editor routes and 12 local edits.
Weidweg opt-out/mode restrictions, retained dismount tags, the Ries correction
and both Kepler cycle-path directions also passed. The native bundle lacks the
optional `surface-v4` comparison profile, so those profile-specific checks used
a temporary profile copy and isolated engine; the original bundle was preserved.
The western composite is still an open product target.

The browser checks cover street/aerial imagery, marker and line dragging,
undo/redo, complete long-route drawing, exact GPX export, draft restoration,
cross-tab protection, storage failures, mobile layouts, surfaces and the
production MapLibre worker. Parity is established for these requests and this
map revision; it does not establish identical choices for every unseen route
or future map update.

Runtime installation, current package versions, the TypeScript 6 compatibility
hold and commands are in [local development](../../docs/local-development.md).
`npm audit` is clean after the package upgrade. The Node 24 LTS HTTP-client
crash found during validation is also documented there; Node 26 passed the
full integration load. The app now runs with that validated runtime.

The dual-origin browser comparison used the then-current Weidweg profile. Its
reports and harness are preserved; the current editor sends the shared-rule
profile instead. The current/legacy server comparison is `npm run routing:benchmark`.
Supporting evidence is retained under `.local/max-optimization/`:
`final-engine-parity.json`, `built-overlay-timing.json`, `cold-routes.json`,
`baseline.jfr`, `after.jfr`, `profile-comparison.json`, `browser-cpu.json`,
the search/engine sweeps, final check logs and npm audit/outdated reports.
The ignored `.cache/max-*.mjs` scripts reproduce the isolated experiments.
The original benchmark bundle and Windows results remain checksum verified.

The performance analysis used
[JFR guidance](https://docs.oracle.com/en/java/javase/21/troubleshoot/troubleshoot-performance-issues-using-jfr.html),
[Graal compiler documentation](https://www.graalvm.org/jdk21/reference-manual/java/compiler/)
and the upstream BRouter implementation. The remaining measured cost is route
search and decoding. Further algorithm or data changes would need new accuracy
and performance evidence; the experiments here do not prove a theoretical
maximum speed.

## Further search tuning, 22 October 2026

The second optimization used `pass2coefficient=0.7` from
`src/config/routing-search.json`, retained as `weidweg-search-v2` in the
comparison tools. `weidweg-search-v1` retains the previous value of `0.5` so that
the first optimization can still be reproduced. The first-pass setting, road
costs, preferences, engine, map data and request concurrency are unchanged.

Fresh route creation through first map drawing, comparing the previous and
current settings in the same browser run:

| Route | Previous `0.5` median (range) | Current `0.7` median (range) | Further reduction |
| --- | ---: | ---: | ---: |
| Graz-Virgen, 338.830 km | 4003 ms (3986-4004) | 3687 ms (3640-3722) | 7.9% |
| Virgen-Mistelbach, 523.295 km | 7773 ms (7772-7790) | 6774 ms (6688-6857) | 12.9% |
| Graz-Virgen-Mistelbach-Graz, 1130.794 km | 8163 ms (8128-8190) | 7173 ms (7002-7173) | 12.1% |

The benchmark uses one warmup and three measured runs per setting and route,
alternates order, and starts every route in an isolated empty browser context.
The native router is already running and warm; background map downloads are
excluded. All 24 builds preserve the full geometry, elevations and surfaces,
send every snap and leg request, draw the complete route and save successfully.
Run `node tests/browser-initial-performance.mjs --baseline 0.5` to reproduce
this comparison. Its report is
`.local/initial-route-speed/browser-comparison-0.5-to-0.7.json`. Earlier reports
remain unchanged. Omitting `--baseline` compares with the original zero default.

Before adoption, paired requests with `0.5` and `0.7` returned identical complete
feature hashes on all 35 existing comparison cases and 16 additional regional
routes. The latter cover eight trips in both directions, including Klagenfurt,
Vienna, Salzburg, Graz, Innsbruck, Lienz, Linz and Villach. All 14 protected review
corridors still match their saved references; the western target remains open.
These checks establish parity on those requests and data, not every possible
route or later map revision.

At this stage `npm run bench:check-reviewed` defaulted to `weidweg-search-v2`.
The current default is v3; the editor unit check verifies all three preset
versions and their original profile and preferences.

An exploratory sweep tested `0.6`, `0.7`, `0.8` and `0.9`. Values of `0.8` and
`0.9` changed part of Graz-Virgen's geometry and increased its profile cost,
despite retaining the same rounded total distance. They were rejected. Exact
geometry and metadata comparisons remain necessary when tuning search order.

An isolated decoder experiment also replaced the byte-refill loop in upstream
`BitCoderContext` with a bulk-read fast path. It matched 865,280 decoder states
and round-tripped 1,000,000 integers. Two warmups and three alternating measured
requests per engine and route found median gains of 2.9% on Graz-Virgen and 2.1%
on Virgen-Mistelbach, saving about 0.10 and 0.14 seconds. All those responses
matched. This prototype remains experimental: the small gain does not justify
adding another engine patch at that stage. The temporary router was stopped.
The later combined runtime experiments above also rejected this decoder.

Evidence is in `.local/initial-route-speed-refinement/`: `sweep.json`,
`parity-0.7/report.json`, `regional-0.7/report.json`, their paired responses,
and `decoder/comparison.json`. The decoder source, test and compiler stay in
that ignored experiment directory. No system compiler was installed and the
original benchmark package was not edited.

## Initial-route search, 22 October 2026

The first search improvement sent `profile:pass2coefficient=0.5`, available as
comparison preset `weidweg-search-v1`. The later active default is recorded above.
BRouter uses this coefficient to prioritize search toward the destination during
its refinement pass; the original default is zero. See the upstream
[search implementation](https://github.com/abrensch/brouter/blob/v1.7.10/brouter-core/src/main/java/btools/router/RoutingEngine.java)
and [coefficient defaults](https://github.com/abrensch/brouter/blob/v1.7.10/brouter-core/src/main/java/btools/router/RoutingContext.java).
The profile, road costs, Thal preference, Weidweg passage, map tiles, six workers
and 1 GB heap remain unchanged. The setting applies per request and requires no
engine rebuild or restart.

Controlled browser measurements on the native Ubuntu router:

| Fresh route | Original median (range) | Optimized median (range) | Reduction |
| --- | ---: | ---: | ---: |
| Graz-Virgen, 338.830 km, one leg | 4554 ms (4488-4556) | 3974 ms (3952-3988) | 12.7% |
| Virgen-Mistelbach, 523.295 km, one leg | 9952 ms (9904-9990) | 7703 ms (7691-7772) | 22.6% |
| Graz-Virgen-Mistelbach-Graz, 1130.794 km, three legs | 10423 ms (10414-10462) | 8161 ms (8123-8231) | 21.7% |

`node tests/browser-initial-performance.mjs` starts each run in an isolated empty
browser context and measures from route creation through the first visible map
line with its source loaded. Each setting receives one warmup and three measured
runs per route, with alternating order. Only the search parameter differs between
requests. The router and filesystem are already warm; background map downloads
are excluded. These measurements do not include application or router startup.

Every run sends all snaps and legs: three requests for each single leg and seven
for the loop. All runs preserve every coordinate, elevation and surface segment,
send complete geometry to the map, save successfully and show no partial initial
route. The loop contains 31,229 vertices. The report is
`.local/initial-route-speed/browser-comparison.json`.

Direct baseline/candidate requests also returned identical complete feature
hashes in 35 cases: the six original benchmarks, the 523 km leg, all 15 review
fixtures, and 13 additional reverse-direction or interior-endpoint routes. All
14 protected corridors remain matched; the western composite remains open. A
more aggressive coefficient of 1 changed route geometry and was rejected. The
35 comparisons establish parity for those requests and data, not a guarantee
for every unseen route or future map update.

This round used `weidweg-search-v1`; use
`npm run bench:check-reviewed -- --settings weidweg-search-v1` to check it or
`-- --settings weidweg-local-v1` for the original search setting. The comparison
provenance includes the new JSON configuration. `npm run test:editor-local`
checks the actual editor's snapping and per-leg requests against the protected
corridors. Saved completed legs keep their existing geometry.

Additional evidence is in `.local/initial-route-speed/`: `parity.json`,
`extra-parity.json`, paired raw responses, candidate profiles and `search.jfr`.
Java samples again concentrate in route search and road-data decoding. No JVM
change was needed. The original benchmark package and Windows baseline still
pass their recorded checksums.

## Long-route surface review, 22 October 2026

The planner now retains BRouter's individual `surface` tags alongside the five
map colour groups. **Beläge prüfen** lists material lengths and route sections;
selecting a section frames and highlights its exact geometry. Missing tags stay
unknown. Inspecting a section does not edit the route, save a new draft or send
routing requests. Older drafts retain their original groups until recalculated.

Four fresh requests to the native Ubuntu router reproduced the benchmark's
complete feature hashes. Their surface lengths, measured along the drawn
coordinates, are:

| Route | Engine route length | Known unpaved | Missing surface tags |
| --- | ---: | ---: | ---: |
| Graz-Virgen | 338.830 km | 382 m | 44.301 km |
| Graz-Vienna | 197.640 km | 476 m | 13.809 km |
| Graz-Mistelbach | 251.789 km | 476 m | 17.557 km |
| Southeast loop | 241.881 km | 0 m | 67.510 km |

The inspector measures geometry with the editor's distance function. Its summed
length can differ slightly from BRouter's reported route length. Recorded metal
is a separate material, not missing information. Zero known unpaved distance does
not establish that the unknown sections are paved.

On Graz-Virgen, the main fine-gravel section is at geometry km 226.739-227.103,
from longitude/latitude `13.551946,46.771611` to `13.547803,46.773242`. It measures
364 m in the inspector and 365 m in BRouter's rounded message distances. Three
other gravel sections total about 18 m. Vienna and Mistelbach share fine-gravel
sections at geometry km 157.420-157.670 and 161.265-161.486, plus about 5 m marked
`unpaved` at km 162.364.

An isolated router tested surface penalties 3, 6 and 10 against all six benchmark
routes and all 14 protected review fixtures. Only the numeric penalty changed;
the engine, map tiles, traffic weighting, Thal preference and Weidweg exception
stayed the same. The following material and road-class distances sum BRouter's
message rows, so they differ slightly from the inspector's geometry measurements.

| Graz-Virgen candidate | Route length | Fine gravel | Other gravel | Missing surface | Primary/secondary roads | Protected routes preserved |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Current penalty 3 | 338.830 km | 365 m | 18 m | 44.382 km | 190.517 km | 14/14 |
| Penalty 6 | 338.622 km | 0 m | 18 m | 43.993 km | 191.899 km | 14/14 |
| Penalty 10 | 338.613 km | 0 m | 10 m | 43.341 km | 191.899 km | 13/14 |

Penalty 6 removes the fine gravel but adds 1.382 km on roads tagged primary or
secondary. The other five benchmark routes retain their distance and material
totals. Penalty 10 also changes the accepted `01-mur-north-automatic` corridor.
For Vienna and Mistelbach it adds 611 m to each route and 1.638 km without a
surface tag, while reducing known unpaved distance from 476 m to 250 m.

The active default remains penalty 3. Road class is not a traffic measurement,
and this experiment does not establish a rider preference for the alternatives.
The western composite remains an open target. Review the changed corridor before
adopting penalty 6; penalty 10 fails the existing protected-route check.

Local evidence is in `.local/long-route-review/`: `baseline-audit.json`,
`surface-penalty-comparison.json`, the four named baseline responses and the
`*-cost-{3,6,10}.json` responses. Candidate profiles are in its `profiles/`
subdirectory. They copy `richi-weidweg-v1.brf` and change only the final `3` in
`assign surfacepenalty = switch surface=... 3 0`. Requests use
`alternativeidx=0` and the unchanged no-go value from
`src/config/thal-preference.json`. Baseline audit group totals include metal in
the old `unknown` colour group; the table above excludes its known 7 m material.
The verified benchmark package and Windows baseline were not edited.

## Graz–Virgen coverage, 22 October 2026

The planner's failed Virgen snap returned HTTP 400 with
`datafile E10_N45.rd5 not found`; the routing service was running. Setup now
includes this [western tile](https://brouter.de/brouter/segments4/E10_N45.rd5)
alongside the existing eastern tile. Combined BRouter coverage is 10–20° E,
45–50° N. GraphHopper and ORS retain their Styria extract.

The added tile is 199,051,014 bytes, downloaded on 22 October with SHA-256
`e55290f2f2c07a0d2c17cb36fcc8bcb4170e750f3f3ef1b205fcca575d06d1f5`.
The 17 October eastern tile was preserved. Both are recorded in `.local/assets.json`;
the cross-tile route succeeds with this pair. Restart BRouter after downloading
data so its Linux-local copy refreshes. Existing installations can run
`npm run bench:setup` followed by
`docker compose -f experiments/routing/compose.yml restart brouter`.

Routing errors now distinguish missing maps, no connection, unavailable service,
time limits and memory limits. A failed leg retains the explanation shown by
the service layer, and retry recovers without replacing the route's points.

The selected Graz–Virgen points produce 338.830 km, 2,231 m ascent and 9,231
vertices. The first direct request after restarting BRouter took 5.286 seconds.
Four subsequent fresh editor builds took 5528, 4653, 4664 and 4670 ms until the
route was visible; each sent two snaps and one route request. The later three
had a median of 4664 ms, with no browser tasks over 50 ms. These are local
performance checks, not rider approval of the roads or a guarantee of paving.
Evidence: `.local/graz-virgen-first.json`, `.local/graz-virgen-response.json`
and `.local/long-browser-virgen.json`. The browser long-route check includes
this trip, full GPX export, reload, editing and undo.

## Long-route performance, 22 October 2026

BRouter now reads a disposable copy of the RD5 files inside its Linux container.
`start-brouter.sh` refreshes this copy on startup; the source files remain in
`.local/data/`. Six workers, the 1 GB Java heap, profiles and road data are
unchanged by the performance changes. Restart BRouter after updating the source
data. The copy used about 130 MB during these measurements; adding the western
tile above brings it to about 329 MB.

A controlled storage comparison made 56 requests with rotated candidate order,
two warmup rounds and five measured rounds per route/storage combination.
Full route feature hashes, including geometry and metadata, matched throughout.
Median engine response times improved by 22-23% on the three long test routes.
The [Docker filesystem guidance](https://docs.docker.com/desktop/features/wsl/best-practices/)
describes the cost of accessing Windows-mounted files from Linux containers.

Completed editor legs now bypass deep reactivity, since edits replace whole
legs. The Weidweg notice rejects coordinates outside the stair area before
running its exact distance checks. Full geometry, surfaces and elevation remain
available for drawing, editing, saving and GPX export.

Fresh builds through the normal editor proxy, median of three warmed runs:

| Route | Before | After |
| --- | ---: | ---: |
| Graz-Vienna, 197.6 km, one leg | 3460 ms | 2785 ms |
| Graz-St Poelten, 195.1 km, one leg | 3229 ms | 2421 ms |
| Southeast loop, 241.9 km, six legs | 541 ms | 425 ms |
| Graz-Mistelbach, 251.8 km, one leg | 5358 ms | 4105 ms |

Every build sent all snap and leg requests; no saved route geometry was reused.
These headless Chrome measurements include the first map render with the loaded
route source. They are local measurements with a warmed engine and filesystem,
not startup guarantees. The first Vienna build after restarting BRouter took
3610 ms. Length alone does not determine latency: the loop's six smaller searches
run concurrently, while a single long leg requires a larger search.

Median time from the last route response to drawing fell from 60 to 18 ms.
Java profiling found route search and RD5 decoding dominate the remaining wait;
garbage-collection pauses totalled about 407 ms across twelve profiled requests.
A separate 40-request comparison of 128 MB and 256 MB per-request memory budgets
found no consistent benefit. That experiment is not enabled in the application.

Evidence: `.local/storage-comparison.json`, `.local/memory-comparison.json`,
`.local/long-browser-pre-change.json`, `.local/long-browser-after.json` and the
associated Java/browser profiles. The ignored profilers are in `.cache/`.
`node tests/browser-long-routes.mjs` checks the 252 km route and 242 km loop,
including complete GPX geometry, draft reload, local editing and undo.

These results support keeping the current Vue/MapLibre frontend and Java router.
They do not establish a universally fastest language or framework. A native
Ubuntu follow-up reproduced all 42 Windows feature hashes. With five measured
samples per route, its medians were 8.8-11.4% lower. Ubuntu used a performance CPU
governor and Windows used Balanced, so the result does not isolate the operating
system's effect. Keep the Ubuntu repository and data on a Linux filesystem.
No application dependencies, paid services or routing-cost changes were
introduced. Additional service charges remain EUR 0.

## Active Weidweg exception, 21 October 2026

The editor now uses `richi-weidweg-v1` with the existing Thal preference and the
`local-bicycle-v2` engine patch. Only the two accepted ramped stair flights near
Weidweg receive a push-through exception, matched by exact endpoints and required
tags. Other stairs retain their existing treatment. The editor identifies this
passage with a “Bitte schieben” notice, also when restoring saved geometry.

`npm run bench:check-reviewed` now defaults to `weidweg-local-v1`. All 14 protected
variants pass, as do the editor integration checks. The western composite remains
open: the stairs account for about 509 m of removed detour, but the complete route
still differs at the Lendkai approach and other road choices. Earlier experimental
profiles and saved results are retained. Run `npm run test:weidweg-local` for the
passage checks; see the [patch guide](brouter-patch/README.md) for scope and rebuilds.

## Reviewed-route checks, 21 October 2026

All twelve scenarios have rider feedback. `fixtures/reviewed-routes.json` retains
15 route expectations with ordered coordinates, request points, source references,
feedback hashes and scope notes. Fourteen protect accepted or preferred corridors;
the western-loop composite is a separate target, not an automatic routing success.
The extra cases cover selected/edited variants and the previously verified
endpoints-only Eggenberg request. Historical source associations are documented
where the rider did not provide a run identifier.

Run `npm run bench:check-reviewed` with the existing local BRouter and prepared
assets. The command validates fixture hashes, routes the stored request points,
compares geometry in both directions, and checks endpoint and waypoint order.
Maximum sampled separation and endpoint displacement must be at most 1 m, with
at most 2 m length difference. The comparison samples at 5 m intervals; it measures
geometry agreement, not road safety, access legality or paving. Surface observations
remain in the source feedback and are not inferred from acceptance.

The command exits unsuccessfully on a protected-route regression or routing error.
An unmet target is reported as `target-open`, never as preserved. Optional
`--settings NAME` uses an existing prepared profile without modifying it.
Requests, raw responses, configuration evidence and results are saved under
`.local/reviewed-route-checks/`. Do not regenerate expected geometry to make a
failed comparison pass; investigate the data/profile change and review its scope.

The initial run preserved all 14 protected variants. The western target remains
open: with its five main points, BRouter's geometry is about 197 m longer than
the accepted composite and takes different roads. That composite includes the
quiet corridor via Überfuhrgasse and a specific short push-through connection.
The lookup data includes `ramp:bicycle`, but the current profile disallows steps.
A future scoped experiment can distinguish bicycle ramps from other stairs;
acceptance of this connection does not authorize changing all stair routing.

`npm run test:editor-local` checks the 14 protected variants through the actual
editor store, snapping and per-leg requests. It also checks that moving a point
preserves distant legs and uses only three requests for the tested local edit.
The initial run passed all route checks and all twelve local edits. Offline
`npm run bench:test` covers fixture integrity, repeated visits, lost return trips,
extra backtracking, reversed endpoints and nearby parallel roads.

## Western-loop diagnostic, 21 October 2026

The empty main editor offers **Beispiel: Westliche Runde über Augasse**. This
loads three stops and six visible shaping points, including four added corridor
choices. The points can be dragged or removed and survive draft restoration.
Loading the example is one undoable action. Existing routes are not replaced
automatically; use **Neue Route** to reach the examples, then **Route zeigen**
to fit the selected route on the map.

`src/config/route-examples.ts` uses accepted reference indices
0, 45, 119, 146, 175, 245, 385, 644 and 874. The actual editor reproduces the
accepted corridor from index 45 onward, about 19.9 km. The opening remains
automatic and the full example is about 21.9 km. This is an explicitly shaped
route, not automatic success for the five-point western target. No access tags
or accepted fixture coordinates were changed. `npm run test:editor-local`
checks the corridor alongside the 14 protected routes.

The browser example check also asserts 17 initial requests: nine snaps and eight
legs. Restoring a completed draft sends none; moving one shape sends three and
undo restores existing geometry. The pending operations map uses the stable
store state as its key because Pinia devtools wrap individual actions in different
store proxies. Using those proxies as keys previously caused 44 initial requests.

The editor and local BRouter now allow six concurrent requests, with the Java
heap still limited to 1 GB. `routingConcurrency` in `route-model.ts` controls
both client queues; the BRouter command in `compose.yml` sets six server workers.
After changing that command, recreate the service with
`docker compose -f experiments/routing/compose.yml up -d --no-deps --pull never brouter`.

Fresh-route comparisons on 22 October used two warmup rounds followed by six
measured rounds, rotating the worker order. Every run started from an empty
editor and requested all snapping and routing work. Median time to visible route:

| Route | 4 workers | 6 workers | 8 workers |
| --- | ---: | ---: | ---: |
| Western loop | 246 ms | 187 ms | 189 ms |
| Eggenberg with waypoints | 121 ms | 111 ms | 110 ms |
| Eastern hills, two points | 69 ms | 68 ms | 69 ms |

Six workers improved the longer route without a consistent benefit from eight.
Geometry hashes matched across all 72 runs. The comparison used direct local
engine ports and warmed routing services. Through the normal app proxy, follow-up
checks measured 191-349 ms after startup and 799 ms on the first request after
restarting the service. These are local measurements, not universal latency limits.
Reports are `.local/browser-worker-comparison.json` and
`.local/visible-route-six-workers.json`.

Run `npm run bench:probe-western` with prepared assets and local BRouter running.
It compares the active scoped Weidweg profile with the previous surface profile,
probes individual sections of the committed western composite, and checks all 14
protected variants. It reads existing profiles without creating or changing them.
Requests, responses, both profile contents, asset provenance and assessments are
saved under `.local/western-gap/`.

The complete loop remains an open target. The scoped stair exception removes
about 509 m of detour, but does not reproduce all the accepted road choices.
The rider explicitly confirmed using the cycle path on Keplerstraße. Retain
that preference when tuning this area. Keplerstraße and Lendkai are distinct
roads; this instruction does not resolve the Lendkai access question below.

Run `npm run test:kepler-local` to protect the eastern 720 m section of
Keplerstraße approaching Keplerbrücke. With only its two cycle-path endpoints,
the active profile follows the cycle path in both directions. The check verifies
ordered path checkpoints, endpoint positions, distance and cycleway tags for
every reported section, including crossings. Checkpoints are not sent as routing
waypoints. This covers the tested section, not the whole street or Lendkai;
no additional routing penalty is needed for these requests.

Local section checks separate the remaining differences:

- The Lendkai road near the Keplerbruecke underpass is tagged
  `bicycle=use_sidepath` in both the saved OSM extract and live BRouter response.
  Ways 115020465, 1123903798 and 1123903799 carry this tag. The profile reports
  a road cost of 27900 per km there. Current signs need clarification before
  treating this as a data error; the rider's preferred geometry alone does not
  establish road access. The diagnostic records these tags and costs.
- Between its accepted entrance and exit, the quiet corridor already matches,
  including the corrected turn through Ueberfuhrgasse.
- The Augasse connection matches with one shaping point at reference index 119.
  Without it, BRouter takes a residential alternative about 260 m shorter.
- The Schlossplatz branch matches with one shaping point at reference index 244.
  Without it, BRouter chooses a different branch about 4 m longer.

These shaping points are diagnostic requests, not new automatic-routing rules
or changes to a saved editor draft. Their coordinates come from the unchanged,
hash-checked accepted fixture. Passing a shaped section does not close the whole
loop target or establish suitability elsewhere. Local section distance differences
must not be added together because the complete route can choose other approaches.

Finite penalties at Neubaugasse and Zanklstrasse did not reproduce the loop.
Combined penalties increased its difference from the accepted route. Reducing
the global traffic penalty also changed large parts of the loop. None of these
experiments was activated. Their local reports are under
`.local/western-preferences-2026-10-21T04-04-33-198Z/` and
`.local/western-traffic-2026-10-21T04-06-49-739Z/`.

The earlier broad ramp experiment and its saved results remain available locally.
It had no geographic or length limit and was superseded by the exact-flight
engine exception described above. The diagnostic no longer generates that profile.

## Route review interface

The comparison uses graphite text, neutral panels and blue controls.
Engine colours are BRouter blue, GraphHopper orange and ORS turquoise, with
matching map lines, legend samples and route-card borders. GraphHopper uses a
solid orange line, BRouter solid blue and ORS solid turquoise, without a white
outline. Selecting an engine highlights its complete route above the comparison
and updates the elevation/surface details. Shared stretches have one representative
line; the map names the engines that share them. Alternative branches remain visible.
Use Next difference to jump between areas where routes diverge. Selection keeps
the current area in view. Use Selected only to show the engine chosen in the sidebar,
or All routes to restore the comparison. Historical review notes below
use the former colours: brown for BRouter, green for GraphHopper and blue for ORS.

The display comparison samples saved geometry every 5 m and groups same-direction
segments within 3 m. Nearby differences within 30 m form one review area; groups
under 10 m combined sampled length are not navigation targets. These tolerances
handle coordinate rounding and keep the review manageable. They do not establish
that nearby paths are identical or measure routing quality. Original route
coordinates remain available for selection, surface inspection and export.

Select an engine in the left sidebar to inspect its saved route. BRouter is
initially selected because these runs contain elevation in its coordinates.
The elevation panel sits directly below the map. Move over the chart or use its
keyboard-accessible distance slider to locate a position on the route.

Surface summaries retain distinct recorded values such as asphalt, stone setts,
gravel and unspecified paving. Click a surface to locate its first section, or
expand the complete section list to select a specific distance interval. The
map zooms to that section; surface colours display only the selected engine.
Return to engine colours for the comparison.

Missing surface tags stay unknown. GraphHopper and ORS have no elevation in
these saved runs; the UI does not borrow BRouter's heights for another route.
Distance positions use the saved geometry rather than rounded engine distances.
ORS values are categories, following its [surface ID documentation](https://giscience.github.io/openrouteservice/api-reference/endpoints/directions/extra-info/surface),
so paving stones may include stone setts and cobblestones.

`route-inspection.mjs` reads existing raw response files through a read-only API.
It does not change benchmark normalization, saved results or routing requests,
and the existing evaluation fingerprint still validates. No dependency was added.

The redesign preserves map backgrounds and the review form.
It moves setup, source notes and timing results into expandable
sections. Desktop keeps the map and profile visible together; mobile puts
secondary controls after the map. Native Vue controls and CSS remain in use.

Validation includes interval endpoints, loops, unknown tails, invalid intervals
and missing heights. `node experiments/routing/tests/browser-inspection.mjs`
checks route selection, keyboard scrubbing, rendered surface layers, section
zoom, absent elevation, details-error recovery and mobile width. It makes no
routing requests. The existing comparison and frozen-evaluation browser checks
also cover the reorganized controls.

## Fixed-settings evaluation, 20 October 2026

Rider review received for scenario 07 Automatic: BRouter and ORS accepted;
GraphHopper's general corridor accepted with its central Feldkirchen manoeuvre
flagged. Saved geometry places the difference at 1.970 to 2.180 km on mapped
pedestrian ways, with about 15 m extra distance. The exact localization comes
from geometry inspection. The rider identified central Feldkirchen, not indices.
Feedback and three result reviews are saved privately. Routing settings remain
fixed; scenario 08 is next.

The first new review is scenario 07 revision 2, Automatic:
http://127.0.0.1:5174/?case=07-south-quiet&variant=automatic&run=2026-10-20T16-56-41-400Z-2ac5138f

Before rider review, its draft start and destination were moved onto mapped
asphalt on Auer-Welsbach-Gasse and Lagerstraße. The old airport-area destination
was off-road and snapped about 190 metres away. The revised automatic routes
reach both points exactly: GraphHopper 4281 m, BRouter 4269 m, ORS 4266 m.
These are routing results, not rider approvals.

Freeze `evaluation-2026-10-20-babe8fc1` keeps `thal-local-v1`, the Ries bicycle
turn patch, local GraphHopper and local ORS. Its private manifest contains
the profile/configuration/scenario snapshots, verified map-asset hashes and
patched BRouter JAR hash. Runs reject changes to these inputs and retain the
freeze ID and fingerprint. The page preserves them when repeating a comparison.
Engine selection cannot change in a loaded frozen run.

For the next case, use the same freeze:

```powershell
node experiments/routing/run.mjs --case 08-andritz-parallel --settings thal-local-v1 --include-ors true --evaluation-freeze evaluation-2026-10-20-babe8fc1
```

Record problems without tuning profiles during this round. Existing baseline
runs mean this is not a blind comparison; only the tuned settings were withheld
from these cases. Map-source dates and elevation differences remain limitations.
This compares engine requests, not the editor's complete snapping/dragging workflow.

`node experiments/routing/freeze-evaluation.mjs` creates a new manifest for a
deliberate new round; do not use it to silently accept changes during this one.
The earlier freeze `evaluation-2026-10-20-d0a4a381` and run ending `a8a673cf` are
retained as superseded evidence of the endpoint-placement problem.

Validation: 23 comparison unit tests and comparison build pass. The browser check
below verifies the saved link, Automatic mode, three routes, fixed engine choice,
repeat-request settings, reload, local road tiles, street map and aerial labels.
The superseded manifest also correctly rejects the revised scenario.

```powershell
node experiments/routing/tests/browser-evaluation.mjs 2026-10-20T16-56-41-400Z-2ac5138f --imagery
```

This experiment compares GraphHopper 11.1 and BRouter 1.7.10 around Graz/Styria,
with optional local OpenRouteService 10.1.0 using `cycling-road`.
It does not modify the original editor. There is no hosted routing fallback.
Routing uses localhost. The default street
map and aerial imagery use the free basemap.at service; Local roads is an offline
background served by GraphHopper.

## Historical Windows comparison setup

Git, Node 22.21.0, Yarn 1.22.22 and Docker were used for this earlier comparison.
Java on the host was unnecessary because both
engines use Eclipse Temurin 21 JRE, pinned by digest in `compose.yml`.
The Docker daemon must run Linux containers.

The project now uses npm and `package-lock.json`. Use the
[historical Docker setup instructions](../../docs/local-development.md#historical-docker-benchmark-installation)
when reproducing these comparisons. The current native planner uses a different
profile and starts with `npm run dev:local`.

Open http://127.0.0.1:5174/. Port 5174 serves the comparison, 8989 GraphHopper and
17777 BRouter. All published ports bind to `127.0.0.1`. The containers use a normal
Docker bridge because an internal network did not publish usable ports on this
desktop. No hosted service endpoints or credentials are configured in the engines.
The comparison Vite config does not load `.env` files or import the old editor.

Stop engines with `npm.cmd run bench:down`. Stop Vite with Ctrl+C in its terminal.
Downloaded files, the imported graph and saved comparisons remain on disk.
The GraphHopper heap is capped at 3 GB and BRouter at 1 GB; allow Docker additional
memory for the OS and native allocations. Initial import took about 21 seconds on
this desktop; other computers will differ.

Local ORS is optional and starts separately with `npm.cmd run bench:ors:up`.
Its port is `127.0.0.1:8082`. Check `/ors/v2/health` for `ready` before requesting
routes; the first launch must import the map. `npm.cmd run bench:ors:down` stops
only ORS. Its local image builds from the upstream version and digest pinned in
`ors-patch/Dockerfile`, with the missing-endpoint import fix documented in
`ors-patch/README.txt`. The first launch builds that image automatically.
The road-cycling profile uses the existing Styria PBF, without elevation, and
keeps its generated files in the ignored `.local/ors/` directory. The Java heap
is capped at 3 GB and the container at 5 GB. No hosted ORS key is needed.

To include ORS, select **Include local OpenRouteService** before Compare routes,
or use `--include-ors true` with `bench:run`. The default remains two engines.
Saved runs record whether ORS was included, its configuration, runtime status,
and each POST request body and response. Recalculating an ORS comparison keeps
that engine enabled. An unavailable local ORS produces a saved error, with no
fallback to the hosted API.

## Run and repeat cases

```powershell
npm.cmd run bench:run
npm.cmd run bench:run -- --split evaluation
npm.cmd run bench:run -- --split all
npm.cmd run bench:run -- --case 06-multiple-shapes --repetitions 3
npm.cmd run bench:run -- --case 06-multiple-shapes --settings traffic-v3 --include-ors true
npm.cmd run bench:test
npm.cmd run bench:build
```

The default split is `tuning`. Six cases are tuning cases and six are held out for
evaluation. Freeze profiles before scoring evaluation cases. `--split all` is
useful as a connectivity smoke test; it does not make cases reviewed evidence.
Repetitions run sequentially, reversing engine order on even repetitions. There
is no automatic retry or warm-up. Response time is client wall-clock time through
receipt of the complete response, before normalization and disk writes. First
requests and filesystem caches affect it. The client timeout is 70 seconds.
Engine failures are saved and cause a nonzero CLI exit status.

Each case contains ordered stops and shaping points. The runner makes:

- An **automatic** request with stops only, retaining repeated turnaround stops.
- A **selected** request with stops and all shaping points in their original order.
- An **edited** request, where specified, moving one shaping point and retaining
  every other input point.

These are complete route requests. Retaining points does not guarantee retaining
the exact roads between them. This is not local route-section splicing. Inspect
whether distant roads survive an edit. No spline previews, sticky bearing logic
or editor behaviour are borrowed from the original app.

## Review in the map

Choose a case and click **Compare routes**, or choose a saved run. GraphHopper is
solid green; BRouter is dashed orange; local ORS, when included, is dotted blue.
The engine checkboxes can hide each line.
The map shows the selected row's repetition for both engines, initially repetition
1. All repetitions appear in the measurement table. Select a row to review it.
The background selector offers Street map with names, buildings and terrain,
Aerial + labels with aerial photography and a transparent label overlay, and
Local roads for the original offline road network. The first two use basemap.at's
public WMTS tiles over HTTPS, without registration, a key or paid services. Their
data covers Austria and can differ from the OpenStreetMap routing data. Attribution
appears on the map. The Local roads view makes no external map requests.

The aerial layer is orthophotography, not satellite imagery. Flight-year markings
appear in the provider's high-zoom tiles. Do not assume imagery depicts current
conditions. Use fullscreen to inspect junctions and reduce route opacity to see
the road underneath. Switching backgrounds preserves the viewport and routes.
The chosen background is remembered in browser local storage. Online tile errors
offer the offline view without changing the routing engines.

Click a road to inspect its name, class, surface, smoothness and bicycle-access
tag from local GraphHopper data. Missing tags are shown as Unknown. These attributes
come from the routing graph, not the photographic image or official basemap.

Rider reviews record unwanted distance, corrections needed, whether chosen roads
were kept, whether distant roads were kept after editing, and notes. Blank
measurements remain `null`, not zero. The reviewer must confirm inspecting the
draft locations. Reviews are separate immutable files; saving again does not erase
earlier observations. The agent has generated no rider judgments.

All 12 scenarios contain generated coordinates. Their candidate corridors,
access, surfaces and expected roads need Richard's review. Empty `expectedRoads`
arrays are deliberate. Fill them with verified road names or OSM way IDs when
reviewing cases. After the pilot, expand toward 40 cases and independent rider
reviews. Optional manual competitor exports may inform review; they are not ground
truth and are not automatically fetched.

## Saved evidence

Private results live under `.local/runs/<run-id>/`:

- `run.json` includes scenario snapshots, exact request URLs, normalized routes,
  timings and errors, engine/profile declarations, asset hashes, configuration
  and profile contents, Node version, Git state and GraphHopper `/info` output.
- `*.request.json` and `*.response.txt` preserve each request and raw response.
  Connection failures have no response file. Interrupted runs retain completed
  requests and the `running` status; they are not reported as complete.
- `reviews/*.json` contains rider reviews. **Export run JSON** exports `run.json`;
  raw responses and separate reviews stay in the local folder.

`setup.mjs` verifies the release checksums from the handoff and records download
timestamps, HTTP Last-Modified, sizes and SHA256 values. It verifies existing assets
before reusing them. Each run verifies downloaded asset hashes and snapshots the
current configuration. Do not modify an imported graph or profile during a run.
The pinned Compose image and declared versions describe this managed setup; the
runner does not attest to arbitrary services substituted on these ports.

## Limitations and profile changes

GraphHopper uses a Styria PBF from OpenStreetMap France. BRouter uses the prepared
`E10_N45.rd5` and `E15_N45.rd5` tiles with different coverage and preparation. HTTP Last-Modified is
not the exact OSM snapshot date. GraphHopper reports the PBF `data_date` in `/info`;
the RD5 source OSM timestamp remains unknown. Keep datasets frozen during a round.
To refresh, preserve the old `.local` directory under another ignored name, then
perform setup and import again.

GraphHopper uses its built-in `racingbike.json` with no elevation in this baseline.
BRouter uses bundled `fastbike.brf`, copied as `richi-road.brf` with
`allow_steps=false`. Other defaults remain unchanged: traffic weight 0.1, elevation
consideration enabled, uphill cost 0, downhill cost 60, ferries allowed and misplaced
via correction disabled. These profiles are candidates, not endorsed road-cycling
settings. Steep-shortcut cases cannot establish controlled gradient preferences
until elevation is aligned between engines.

Unknown surface uses geometry-weighted GraphHopper intervals or BRouter message
distances and explicit surface tags. Missing/other values count as unknown.
BRouter's rounded message distances and GraphHopper geometry lengths are not
identical measures. Unknown does not mean unpaved; known does not establish comfort,
access or suitability. Unwanted sections and corrections require rider review.

When changing GraphHopper encoded values, input data or profile, stop the engines,
preserve the existing graph cache under an ignored backup name, and rebuild it.
Do not reuse a graph built with different settings. Restart BRouter after profile
changes. Run tuning cases before considering a new frozen evaluation.

## Desktop validation, 2026-10-17

The first full smoke run was `2026-10-17T20-32-45-933Z-72a1c9bd`: 56/56 requests
succeeded across 12 cases and both engines. Median response times were about 6 ms
for GraphHopper and 107 ms for BRouter, for 28 requests each after an initial case
had warmed parts of the engines. These observations from one local run are not
route-quality scores or a latency guarantee. GraphHopper reported the PBF source
date as `2026-10-17T01:29:21Z`.

The isolated build and 11 focused Node tests passed. Chrome checks covered saved
runs, variants, point counts, engine toggles, empty review measurements, required
reviewer validation, export, a live comparison, mobile width and zero external
HTTP requests in Local roads mode. Additional browser checks verify real street,
aerial and overlay tile responses, road inspection, mode persistence and failure
handling, allowing only `maps.wien.gv.at` as an external host. Screenshots are
ignored in `browser-artifacts/`.

Road-detail failures now check the local GraphHopper service before suggesting
`bench:up`. Other map errors do not imply an engine outage. The warning's
**Retry map** button reloads tiles without changing the selected route or view.
Browser regression checks cover a failed tile with a healthy service, an
unavailable service, recovery, and a delayed health response after recovery.

To repeat the browser check, with Chrome installed, a saved `--split all` run,
the comparison server and both engines running:

```powershell
npm.cmd install --prefix .cache/browser-tools --no-save --package-lock=false --cache .cache/npm playwright-core
node experiments/routing/tests/browser-smoke.mjs
node experiments/routing/tests/basemaps-browser.mjs
```

Chrome uses a separate headless profile. The test does not access existing tabs
or write rider reviews. `bench:build` checks types and bundles the UI; the live API
and tile proxy are provided by `bench:dev`, not a standalone static deployment.
The old editor build still fails with pre-existing TypeScript errors. Its tracked
and pre-existing untracked files were preserved.

## First rider feedback and scenario 03 correction, 2026-10-18

Qualitative feedback is saved locally in `.local/feedback/`, separately from scored
run reviews. Scenario 01 favours GraphHopper overall, with BRouter's shorter
cycle-path opening to Keplerbrücke also acceptable. The preference concerns the
wide, continuous Mur path in that area, not every riverside path. Scenario 02's
shared route is accepted; staying on the east bank at Schönaubrücke is an optional
alternative. No unwanted-distance measurements were invented from these comments.

Scenario 03 exposed two distinct problems: the generated building destination
snapped onto a park path, and both baseline profiles made unwanted road choices.
The [official Schloss Eggenberg park rules](https://www.museum-joanneum.at/schloss-eggenberg-prunkraeume-und-gaerten/ihr-besuch/anfahrt-und-standort/parkordnung)
prohibit both cycling and bringing bicycles into the park. BRouter's original
response includes `bicycle=no` segments; its fastbike profile allows walking
access with a penalty. GraphHopper's original response ends on gravel footways.
The full original run remains unchanged at `2026-10-17T20-32-45-933Z-72a1c9bd`.

Scenario 03 revision 2 moves only the destination to a point on Herbersteinstraße
at `[15.395033, 47.071639]`, about 50 m from the original coordinate. Its Chosen
roads variant replaces the original draft shaping point with four points on the
south-side cycle path, derived from the local road geometry and rider feedback.
Automatic mode still receives only the two stops. Engine profiles are unchanged.
The revision 2 baseline is `2026-10-18T05-40-46-268Z-c4e168ca`, with four successful
results. Each reaches the corrected endpoint within 0.14 m of the request and
avoids the original park approach. This removes that particular detour; it does
not fix the engines' general treatment of bicycle restrictions.

| Revision 2 route | GraphHopper | BRouter |
| --- | ---: | ---: |
| Automatic distance | 1.90 km | 1.90 km |
| Chosen roads distance | 2.09 km | 2.05 km |
| Secondary-road length in Chosen roads | about 819 m | 0 m |

BRouter's selected route has no secondary-road segments, but that alone does not
prove it stays on the intended side. After further rider feedback, seven longitude
cross-sections against the local road geometry place the saved Chosen roads
BRouter route south of the carriageways. Its Automatic route uses the north side
at the eastern checkpoints. GraphHopper visits all four shaping points but still
returns to secondary roads between them. Both Chosen roads routes initially go
east to the crossing, as the rider subsequently requested. Road-class lengths
come from engine responses, not traffic measurements or rider scores.
The subsequent review of the exact Chosen roads view accepts BRouter through
point 5 and prefers GraphHopper afterward. BRouter's extra side change to use a
short remaining cycle-path section is unwanted there; continuing on the road is
preferred. These segment selections are recorded against the saved run in
`.local/feedback/03-eggenberg-junction-selected-2026-10-18.json`. Neither whole
engine route is accepted. These selections define the reference for the candidate
below; that derived reference is not an engine-generated route or a new rider review.
The UI uses saved scenario snapshots and warns when an older revision is shown.
Browser tests cover switching between the original and corrected routes, along
with the existing map and review checks.

The address now retains `case`, `variant` and `run` parameters. Opening or
refreshing that link restores the same comparison and mode, including held-out
cases. A missing comparison produces an error instead of silently loading a
different run. A label above the map explains whether chosen-road points are
applied. Both engine colours can be displayed in either mode. The further rider
report did not identify the displayed variant, so it remains separate from the
later feedback on the explicitly linked Chosen roads view.

## Cycle-path candidate, 2026-10-18

`cyclepath-v1` changes BRouter only. GraphHopper and both baseline profiles remain
unchanged. The saved comparison selector and map caption identify the settings;
**Compare routes** repeats the displayed settings. Older comparisons use baseline
settings. New command-line runs default to baseline.

The candidate increases `consider_traffic` from 0.1 to 0.5, reduces the cycleway
cost factor from 1.3 to 1.1, and reduces a crossing-node penalty from 300 to 60
when `highway=crossing`, `bicycle=no` and foot access is allowed. These are routing
costs, not measured traffic or crossing delays. This last change removes the
unwanted detour after point 5. Larger crossing penalties tested locally created
other detours and were discarded.

A bicycle restriction on a crossing node can concern crossing the road rather
than travelling along it ([OSM crossing documentation](https://wiki.openstreetmap.org/wiki/Tag:highway%3Dcrossing)).
The pinned [BRouter MTB profile](https://github.com/abrensch/brouter/blob/v1.7.10/misc/profiles2/mtb.brf)
also uses a cost of 60 for this node combination. The candidate retains other
access costs and adds a foot-access guard. It does not resolve the baseline's
general willingness to use some bicycle-prohibited ways with a walking penalty.

Generate a candidate run with:

```powershell
npm.cmd run bench:run -- --case 03-eggenberg-junction --settings cyclepath-v1
```

The runner creates a separate `richi-cyclepath-v1.brf`, snapshots its contents and
hash, and refuses to overwrite a different file with the same profile name.
Candidate settings are limited to tuning cases; requests involving held-out
evaluation cases are rejected until a later frozen evaluation is implemented.

The three recorded candidate runs are:

| Case | Saved run | Finding |
| --- | --- | --- |
| 01 | `2026-10-18T06-33-48-198Z-807981e9` | Automatic route changed; needs rider review. |
| 02 | `2026-10-18T06-33-48-836Z-71397860` | Accepted Automatic geometry retained. |
| 03 | `2026-10-18T06-33-49-477Z-92e8217f` | Rider accepted the complete BRouter Chosen roads route. |

[Open scenario 03 with the candidate and Chosen roads](http://127.0.0.1:5174/?case=03-eggenberg-junction&variant=selected&run=2026-10-18T06-33-49-477Z-92e8217f).
The orange route is a complete BRouter response, not a splice of the references.
Automatic scenario 03 still takes an unwanted opening: the successful Chosen
roads result supplies four explicit shaping points. The rider subsequently
confirmed that the complete brown BRouter route is how they would ride it.
Acceptance is recorded in
`.local/feedback/03-eggenberg-junction-cyclepath-v1-accepted-2026-10-18.json`,
against this saved result. Earlier segment feedback remains intact. This accepts
scenario 03 Chosen roads, not Automatic or the profile across other scenarios.

`node experiments/routing/check-tuning.mjs` checks the saved runs against local
feedback and writes `.local/cyclepath-v1-checks.json` and the derived scenario 03
reference GeoJSON. It requires this desktop's ignored run-ID mapping, runs and
feedback files. Sampling both directions every 5 m finds less than 1 m separation
for scenario 02 Automatic and scenario 03 Chosen roads; length differences are
less than 2 m, with matching endpoints. These tolerances describe stored route
geometry, not real-world positional accuracy, access or safety. The report also
verifies that baseline BRouter and GraphHopper configuration hashes are unchanged.
Scenario 01's geometry comparison is exploratory, not a route-quality score.

Validation passed: 15 Node tests, the isolated UI build, and Chrome checks for
candidate/baseline labels, retaining settings on recompute and exact comparison
links. Street/aerial tile and road-detail recovery checks also passed. All routing
remains local and additional service charges remain EUR 0.
The following experiment addresses the Automatic opening. Keep held-out
evaluation cases unchanged until settings are frozen.

## Automatic route candidate, 2026-10-18

`network-v2` builds on `cyclepath-v1`. It adds 1.5 to the distance cost factor for
`highway=cycleway` ways outside the mapped bicycle-route network. The existing
`any_cycleroute` expression checks international, national, regional and local
bicycle-route tags; proposed routes remain excluded. Turn penalties, crossing
costs, access handling, endpoints and source data stay unchanged. There are no
coordinate-specific rules or hidden shaping points.

This is a strong preference: an otherwise identical cycleway has base cost 1.1
on the network and 2.6 outside it. It can favour a road over an unlisted cycleway,
so this remains a separate experimental profile, not the default. Lower turn
penalties brought back the unwanted side change after point 5 and were rejected.
Network penalties of 1.4 and 1.5 matched the reference in this case; 1.3 retained
the unwanted opening, and 2.0 introduced another departure from the reference.
This sensitivity and the limited tuning evidence do not establish general route
quality. Raw requests, responses and exact probe profiles remain under
`.local/automatic-probes-v1/` through `.local/automatic-probes-v4/`.

[Open scenario 03 Automatic with network-v2](http://127.0.0.1:5174/?case=03-eggenberg-junction&variant=automatic&run=2026-10-18T06-46-59-487Z-0c3fd994).
The brown BRouter route matches the accepted `cyclepath-v1` Chosen roads geometry
within 1 m in the sampled comparison, using only the original two endpoints.
The Chosen roads result remains unchanged. The accepted `cyclepath-v1` result and
profile remain available; the rider has not separately approved `network-v2`.

Scenario 02 Automatic is retained in run `2026-10-18T06-47-12-643Z-a1146522`.
Exploratory requests for the other tuning cases found changes in 01 and 06;
04 and 05 matched their baseline Automatic geometry. Scenario 01 was about 405 m
longer than `cyclepath-v1` and diverged from it by up to 507 m in sampled geometry.
Scenario 06 was about 145 m longer than baseline. These differences are not
evidence of improvements. Those probes are saved separately from the selectable
comparisons. A later selectable scenario 01 run received the feedback below;
scenario 06 remains unreviewed. No held-out cases were used.

```powershell
npm.cmd run bench:run -- --case 03-eggenberg-junction --settings network-v2
node experiments/routing/check-automatic.mjs 2026-10-18T06-46-59-487Z-0c3fd994 2026-10-18T06-47-12-643Z-a1146522
```

The geometry audit checks both directions, length and endpoints against the
accepted saved route. It also verifies that Automatic sends exactly two stops
to BRouter, that the accepted v1 profile is unchanged, and that baseline BRouter
and GraphHopper configuration hashes are unchanged. Its report is saved as
`.local/network-v2-checks.json`. The 15 Node tests, isolated build and Chrome
checks passed, including Automatic link reload with two map markers and keeping
`network-v2` when recalculating. Saved comparisons show their profile version.
Street/aerial and recovery browser checks passed on retry after an online-tile
loading timeout. Additional service charges remain EUR 0.

## Scenario 01 network-v2 feedback, 2026-10-18

The rider reviewed Automatic run `2026-10-18T07-19-54-596Z-a1cad14d`, comparing
brown BRouter `network-v2` with green baseline GraphHopper. They strongly prefer
BRouter's opening cycle path, including the path under Keplerbrücke that they
report avoids one traffic light. At the subsequent route separation, they prefer
GraphHopper's Mur cycle path over BRouter's roads in this area.

This accepts different sections, not either complete route. The exact transition
coordinate is not yet established. The feedback is saved separately in
`.local/feedback/01-mur-north-network-v2-automatic-2026-10-18.json`; earlier feedback
remains intact. No distance scores or composite route have been invented.
The next tuning step must preserve the opening and underpass while recovering
the preferred Mur path, checking scenarios 02 and 03 for regressions. Investigate
the network penalty's effect on that path before changing settings. This feedback
does not justify a universal preference for riverside routes.

## Mur-path and traffic candidate, 2026-10-18

The reviewed scenario 01 geometries share a vertex at `[15.420530, 47.092245]`
before the long divergence. The derived reference takes BRouter through index 79
and GraphHopper from index 96 onward in run `2026-10-18T07-19-54-596Z-a1cad14d`.
Both coordinates match exactly, so no connector was invented. This interpretation
of the rider's sections is recorded in `.local/mur-v3-reference.geojson`; the
rider did not supply that exact coordinate or review the resulting composite.

Local inspection found roughly 600 m of the preferred path without bicycle-route
network membership. `network-v2` assigns those cycleways cost 2.6 instead of 1.1.
It also found 61 m of route-message distance tagged `bicycle=dismount` and
`surface=gravel`. The [city's Pongratz-Moore-Steg construction notice](https://www.graz.at/cms/beitrag/10421066/8770127/)
describes an east-bank walking corridor of approximately 100 m. The map-data
distance and the city description are different measures, not evidence that the
restriction has ended. The scenario now shows a dated construction note with the
source link, including when viewing older saved comparisons.
The rider subsequently confirmed that this is a very short construction site
for the bridge renewal, expected to finish by the end of 2026. That confirmation
is saved in `.local/feedback/01-pongratz-moore-construction-2026-10-18.json`.
Treat this as a temporary restriction, separate from their preference for the
Mur path. The rider then explicitly preferred staying on this path despite the
short works rather than taking the road detour. That decision is saved separately
in `.local/feedback/01-mur-construction-preference-2026-10-18.json` and resolves
the earlier pending choice. The construction/dismount note stays until reopening
is verified. The user's comment that a skilled rider could physically ride there
does not change the access tags or establish a general construction-site preference.

`traffic-v3` keeps the network preference and raises `consider_traffic` from 0.5
to 2. It reduces the foot-accessible `highway=crossing bicycle=no` node cost from
60 to 20 to preserve the short road finish in scenario 03. Other access penalties,
including dismount ways, stay unchanged. The traffic multiplier is deliberately
stronger than the bundled profile's highest labelled UI choice of 1; it is an
experimental routing weight, not live traffic data. No river, coordinate or road
name preference was added, and baseline GraphHopper remains unchanged.

The saved runs are:

| Case | Saved run | Geometry check |
| --- | --- | --- |
| 01 | `2026-10-18T07-30-30-760Z-611359f3` | Automatic matches the derived brown-opening/green-Mur reference. |
| 02 | `2026-10-18T07-30-31-428Z-5aae9ebb` | Automatic retains the accepted route. |
| 03 | `2026-10-18T07-30-32-069Z-71479304` | Automatic and Chosen roads retain the accepted route. |

[Open scenario 01 Automatic with traffic-v3](http://127.0.0.1:5174/?case=01-mur-north&variant=automatic&run=2026-10-18T07-30-30-760Z-611359f3).
All three Automatic requests contain exactly the original start and destination.
The sampled comparisons find less than 1 m separation and less than 2 m length
difference from their references. This establishes agreement with stored geometry,
not uninterrupted rideability or general rider approval. Earlier profile files
and saved comparisons remain intact.

```powershell
npm.cmd run bench:run -- --case 01-mur-north --settings traffic-v3
node experiments/routing/check-automatic.mjs 2026-10-18T07-30-32-069Z-71479304 2026-10-18T07-30-31-428Z-5aae9ebb 2026-10-18T07-30-30-760Z-611359f3
```

The audit verifies the reference's source segments and join, request points,
profile/configuration hashes, route lengths and both directions of geometry.
It saves `.local/traffic-v3-checks.json`. Probe requests and rejected profiles
remain under `.local/mur-probes-v1/` and `.local/mur-probes-v2/`. Higher traffic
weights alone restored the unwanted side change in scenario 03; the crossing-node
adjustment was needed to retain that route.

The candidate substantially changes unreviewed tuning cases 04, 05 and 06. Their
Automatic lengths differ from baseline by approximately -2,566 m, +161 m and
+176 m respectively, with different corridors. These are observations, not
improvements or scores. `traffic-v3` remains a separate experimental setting;
held-out evaluation was not used. The 15 Node tests, isolated build and Chrome
checks passed, including the visible construction note, saved settings and
recalculation. The scenario 01 street-map screenshot rendered successfully.
The separate full basemap browser check timed out twice while waiting for
`maps.wien.gv.at` aerial tile requests; it did not pass in this round. Request
diagnostics now identify pending tiles on timeout. Additional service charges
remain EUR 0.

## Scenario 06 Automatic review, 2026-10-18

The rider reviewed `2026-10-18T15-54-01-671Z-dfc40a60` with `traffic-v3` in
Automatic mode and found both routes good. They slightly prefer brown BRouter
because it uses more cycle tracks away from direct traffic and feels safer to
them. This is a qualitative preference, not a measured safety result. Feedback
is saved in `.local/feedback/06-western-graz-traffic-v3-automatic-2026-10-18.json`.
All six engine requests in this saved comparison succeeded. In the subsequent
Chosen roads review, the rider preferred brown BRouter from point 1 to point 2
for its quieter road instead of crossing Lendplatz directly, and preferred brown
for the rest too. Green GraphHopper was also acceptable.

The rider rejected two draft locations: point 3 at `[15.3990, 47.0890]` sends the
route in the wrong direction for the destination, and point 4 at
`[15.3885, 47.0780]` is a dead end that forces a detour. These are input-location
problems, not evidence of routing-engine failures. The review is saved in
`.local/feedback/06-western-graz-traffic-v3-selected-2026-10-18.json` against the
unchanged run. Revision 2 below corrects these locations while preserving the
preferred opening through point 2. The subsequent review below records the
preferences for the corrected and edited routes. No quantitative detour scores
were supplied.

## Scenario 06 corrected locations, 2026-10-18

Saved comparison `2026-10-18T16-17-33-504Z-455e69f7` uses scenario revision 2
with unchanged `traffic-v3` settings. Points 1 and 2 retain their coordinates.
Point 3 now lies on Alte Poststraße at Andreas-Hofer-Straße and point 4 on
Heinrich-Heine-Straße. The destination marker now sits on Reininghausstraße
at the road arrival already used by both engines, about 100 m from the old
off-road marker. These placements were generated from local route geometry and
street names. The subsequent rider review is recorded below.

[Review corrected scenario 06, Chosen roads](http://127.0.0.1:5174/?case=06-multiple-shapes&variant=selected&run=2026-10-18T16-17-33-504Z-455e69f7).
Brown BRouter is 5.315 km and green GraphHopper is 4.952 km. Both retain their
original geometry from point 1 through point 2. The new points 3, 4 and 5 are
within one metre of each engine's geometry. Neither Chosen roads route repeats
an exact road segment. These checks establish geometry properties, not safety
or legal access. The original comparison remains available with its old points.

After an edit moves only point 3 about 140 m west to Vinzenzgasse at
Andreas-Hofer-Straße. Both engines retain the opening through point 2 and the
final approach from point 4 to point 5, within one metre in the sampled checks.
Neither edited route repeats an exact segment. Automatic geometry differs from
the preceding saved comparison by less than 0.1 m after the destination-marker
correction. Checks are saved in `.local/western-revision-checks.json`.

An earlier placement for point 4 on Reininghausstraße made BRouter retrace about
178 m and was rejected. A separate, larger edit probe moving point 3 south on
Alte Poststraße produced about 1.1 km of repeated BRouter segments. Its evidence
remains in `.local/western-points-edited-probe.json`; the smaller westward edit
does not resolve that separate routing issue. The 15 Node tests and local-map Chrome
checks passed, including the revised markers and preservation of the four
unchanged points when switching to After an edit. Additional service charges
remain EUR 0.

The rider then replied, "yes, i would choose brown", to the corrected Chosen
roads comparison and the question about points 2 through 5. This records a
preference for BRouter's corrected route, with the previously preferred opening
preserved. Feedback is saved in
`.local/feedback/06-western-graz-revision-2-selected-2026-10-18.json` against the
exact run and result. No new measurement or assessment of green was supplied.

[Reviewed scenario 06 After an edit](http://127.0.0.1:5174/?case=06-multiple-shapes&variant=edited&run=2026-10-18T16-17-33-504Z-455e69f7).
Only point 3 moves west to Vinzenzgasse at Andreas-Hofer-Straße. The rider replied,
"i would ride brown", when asked to compare points 2 through 4. The opening
through point 2 and the final approach from point 4 to point 5 retain their
geometry. The preference is saved in
`.local/feedback/06-western-graz-revision-2-edited-2026-10-18.json` against the
edited BRouter result. This completes the current scenario 06 review sequence;
it does not resolve the separate larger southward edit probe. No quantitative
measurements or new assessment of green were supplied. Next review scenario 04
Automatic with the same settings to inspect potential unpaved shortcuts near Thal.

## Scenario 04 surface review prepared, 2026-10-18

[Review scenario 04 Automatic](http://127.0.0.1:5174/?case=04-thal-surface&variant=automatic&run=2026-10-18T16-24-27-132Z-2abbef07).
All four requests succeeded with unchanged `traffic-v3` settings. Automatic
uses only the start and destination. Brown BRouter is 6.314 km; green
GraphHopper is 7.650 km. Both include sections tagged with unpaved surfaces.
BRouter message distances report about 3,161 m compacted, 644 m gravel,
172 m fine gravel and 12 m ground, plus 508 m without a surface tag.
GraphHopper geometry intervals report about 959 m gravel, 171 m compacted,
143 m ground and 503 m with missing surface data. The engines use different
data preparation and distance accounting; these are tag observations, not
field measurements or proof of present surface conditions. The start and end
snap about 5 m and 11 m respectively in both engines.

Ask the rider which sections are actually paved or unsuitable and which paved
road they would use instead. Do not assume either whole route is appropriate
for road cycling or treat the shorter brown route as an improvement. Neither
route has been reviewed. No profile changes or additional service charges.

## Operating costs

Route calculation uses local BRouter and GraphHopper. Rider feedback informs
profile rules and saved regression comparisons. Self-hosting consumes hardware
capacity. EUR 0 describes this local experiment,
not a verified operating budget for hundreds of users. Concurrent routing load,
map delivery and any hosted infrastructure require separate capacity and cost
checks before a public launch. No paid services were enabled.

## Original application and engine choice, 2026-10-18

The rider clarified that "my own chosen models/data" means the original
RichiRoute implementation and routing setup. Preserve that application as the
product being developed. This comparison is an isolated experiment, not a
replacement editor or a final decision to use BRouter.

The active original application loads `src/components/map/MapView.vue` through
`HomeView.vue`. It uses `src/stores/route.store.ts` and
`src/services/route.service.ts`. Actual requests go to hosted OpenRouteService's
`/v2/directions/cycling-road/geojson` endpoint. The service sends coordinates,
snapping radii and selected bearings; it does not supply a custom trained model
or the surface/traffic profile rules developed in this experiment. Some debug
payloads and earlier documentation still say `cycling-regular`, but the active
service endpoint is `cycling-road`. Separate older files use that regular
profile and must not be mistaken for the active application.

The original Vue/Pinia/MapLibre interface, stops and shaping workflow are
reusable. Its routing service and editing logic are distinct responsibilities.
The existing special case for two stops and one dragged shaping point requests
two legs; general shaping sends a whole-route request. This does not establish
the product's intended guarantee that distant selected roads survive every edit.
Changing the engine alone will not repair editor ordering or stale-request issues.

MapTiler supplies the original map style and geocoding. Provider capacity for
those services needs consideration separately from routing. We did not launch
the original app or call hosted ORS/MapTiler during this inspection.

[OpenRouteService supports self-hosting](https://github.com/GIScience/openrouteservice#installation),
so its hosted API limits do not require abandoning that engine. Local ORS is now
an optional third engine in this comparison. The handoff deliberately started
with GraphHopper and BRouter and left ORS optional and off. Do not infer that ORS
lost a benchmark or that the original application has been migrated. No final
engine choice has been made.

## Surface probes, not promoted, 2026-10-18

The original BRouter Automatic route for scenario 04 was 8.899 km with 663 m
tagged ground. `traffic-v3` changed it to 6.314 km with 3,989 m carrying explicit
unpaved surface tags. The profile's cycleway branch assigns a low cost without
checking surface. Increased road-traffic penalties make this weakness relevant
to the Thal route. These are local profile/data findings, not proof of actual
surface conditions or an engine-wide ranking.

Three separate probes add a per-metre cost factor of 3, 6 or 12 for explicit
unpaved tags across road classes. All return an 8.904 km Automatic route with
663 m tagged ground and 1,157 m without surface information. The remaining
ground occurs near the start: about 401 m on a track tagged very bad smoothness,
followed by 262 m on a designated bicycle path. No point was moved to conceal
these sections. Chosen roads still contains an additional 82 m tagged grass.

The lowest penalty preserves sampled geometry in scenarios 02 and 03 and all
three current scenario 06 variants. It changes scenario 01 away from the
preferred Mur route, with maximum sampled separation about 599 m. Therefore no
probe became a new public setting, and `traffic-v3` remains unchanged. Inspect
the Thal start location and actual surfaces, and address short accepted walking
sections versus long unpaved shortcuts before choosing a surface policy.

Requests, responses, source hash, summaries and regression measurements are in
`.local/thal-surface-probes/`. Probe profiles have distinct filenames; earlier
profiles and saved comparisons remain intact. These requests used local engines
only, with EUR 0 additional service charges. Held-out evaluation was not used.

## Local OpenRouteService comparison, 2026-10-18

Local ORS 10.1.0 now runs alongside the other engines on this Windows machine.
Only `cycling-road` is enabled, using the same Styria PBF as GraphHopper,
dated 2026-10-17T01:29:21Z. Elevation is disabled. This tests ORS defaults, not
the original editor's bearing, snapping or shaping behaviour. The `traffic-v3`
setting still changes only BRouter. No hosted routing or paid service is used.

The stock ORS image crashed during import with a NullPointerException in
`ORSOSMReader.recordEstimatedWayDistance`: a way endpoint had no coordinates.
The local `missing-endpoint-v1` patch leaves that optional distance estimate
unset and logs the affected way ID. It does not alter route preferences or
invent coordinates. Source, build instructions and limitations are in
`ors-patch/README.txt`. The original failed import directories remain ignored.
The patched import completed in about 41 seconds and the health endpoint
reported ready. A restart successfully reused the generated graph.

| Scenario | Saved comparison | ORS Automatic / Chosen roads / After an edit |
| --- | --- | --- |
| 06 western Graz revision 2 | `2026-10-18T16-48-18-893Z-38d38251` | 3.134 / 4.977 / 4.843 km |
| 04 Thal | `2026-10-18T16-48-23-850Z-1fda0c74` | 7.799 / 9.116 / not applicable |

[Review western Graz with ORS in blue](http://127.0.0.1:5174/?case=06-multiple-shapes&variant=selected&run=2026-10-18T16-48-18-893Z-38d38251).
[Review Thal Automatic with all three engines](http://127.0.0.1:5174/?case=04-thal-surface&variant=automatic&run=2026-10-18T16-48-23-850Z-1fda0c74).

All 15 requests succeeded. GraphHopper and BRouter geometries match their
previous saved comparisons exactly. ORS Thal Automatic still contains about
1,151 m tagged gravel and 272 m compacted, with 503 m unknown. It is not yet an
accepted road-bike route. The ORS routes await rider review; earlier judgments
about brown and green do not transfer to blue. No engine winner is declared.

After these runs, Docker reported ORS at about 1.31 GiB RAM, GraphHopper at
1.59 GiB and BRouter at 246 MiB. These are observed local readings, not capacity
or production load guarantees. ORS remains capped at a 3 GB Java heap and a
5 GB container limit. Regional routing needs no new hardware on this desktop.

Validation passed: 18 Node tests, the isolated TypeScript/Vite build, and the
browser smoke test with the optional ORS run ID. Browser checks covered three
routes, toggles, review labels, edited points, recalculation and reload keeping
ORS enabled, and mobile width. Those checks used local road tiles and made no
external requests; they do not validate current street/aerial tile availability.
The original application's existing TypeScript failures remain outside this
experiment. Detailed ORS metrics are in `.local/ors-validation.json`.

## Rider review of ORS in western Graz, 2026-10-18

The rider reviewed Chosen roads in `2026-10-18T16-48-18-893Z-38d38251` and
still prefers brown BRouter overall. They describe blue ORS as almost identical
to green GraphHopper, except for a particularly bad turn at the beginning of
Peter-Tunner-Gasse. They prefer the path taken there by green and brown and
report that it is new this year. The opening date is rider evidence, not an
independently verified date. Feedback is saved in
`.local/feedback/06-western-graz-ors-selected-2026-10-18.json`.

The local divergence begins near `[15.415535, 47.083293]`. Both ORS and
GraphHopper use the same 2026-10-17 PBF. Local probes show that ORS can route
a 47.9 m section of the preferred southern path in both directions, with a
3 m snapping radius. The path sample is present and routable. Its absence from
an old map therefore does not explain that sample; the exact weighting or
junction rule behind the full-route choice remains unconfirmed.

A diagnostic extra shaping point on that path makes ORS visit it and then
backtrack to its northern choice, yielding 5.021 km rather than 4.977 km.
That is not a correction and has not been promoted into the scenario. The
first strict-radius probe failed because the original start is about 30 m from
the route; that failure is also preserved. Requests and responses are in
`.local/ors-peter-tunner-probes.json`; local instruction responses are saved as
`.local/graphhopper-western-instructions.json` and
`.local/ors-western-instructions.json`. No routing settings or earlier saved
comparisons changed. Thal Automatic remains the next pending surface review.

## Thal unpaved routes rejected, 2026-10-18

In Automatic comparison `2026-10-18T16-48-23-850Z-1fda0c74`, the rider
explicitly rejects brown BRouter from Thalerstraße as unpaved and an absolute
no-go. They then identify a woodland shortcut used by green GraphHopper as
unpaved too. Both routes fail this road-cycling review. The precise boundaries
of the woodland shortcut have not yet been identified; no measured unwanted
distance or correction count is inferred. Blue ORS remains unreviewed and
also contains unpaved surface tags, so it is not an approved paved alternative.

The full remarks are saved in `.local/feedback/` as
`04-thal-traffic-v3-unpaved-rejected-2026-10-18.json` and
`04-thal-graphhopper-woodland-rejected-2026-10-18.json`.
`rider-rejections.json` records the route geometry hashes and source run IDs.
The comparison API attaches these later assessments without altering original
run files. The page labels both rejected routes, including a subsequent run
that returns the identical route for the same engine, case and variant.
A changed route needs fresh review; absence of a rejection label is not approval.

The failure is material: cycleway preference must not outweigh the requirement
to avoid long unpaved routes. Do not promote `traffic-v3` as a validated road-bike
profile. The previous surface penalty probes remain unpromoted because they
still contain unpaved sections and lose the accepted Mur route. The rider's
explicit exception for a short temporary Mur construction section remains a
separate local decision. A paved Thal alternative and a revised surface policy
are still needed. No engine settings or saved route geometries were changed.

## Thal start correction, 2026-10-18

The rider then pointed out that point 1 itself appeared to be in the woods.
The saved data confirms this: the snapped start `[15.391465, 47.091596]` is on
a ground track, followed by gravel. BRouter tags the opening `smoothness=very_bad`.
This is a generated scenario error. The original routes remain unsuitable, but
their unavoidable unpaved opening cannot fairly establish an engine preference
failure. This supersedes any implication above that the original whole-route
outcome alone proves a surface-weighting fault in every engine.

Revision 2 moves only the start to `[15.392482, 47.099327]`, at the mapped
asphalt junction of Göstinger Straße and Thalstraße. Settings and destination
are unchanged. The intermediate shaping point remains a draft, so review
Automatic first. Rider feedback and the location diagnosis are saved in
`.local/feedback/04-thal-invalid-woodland-start-2026-10-18.json`.

[Review corrected Thal Automatic](http://127.0.0.1:5174/?case=04-thal-surface&variant=automatic&run=2026-10-18T17-04-18-100Z-16055074).
All six requests succeeded in this new immutable comparison. Automatic green
is 5.874 km and blue 5.873 km; both are tagged asphalt except for approximately
503 m of unknown surface near the destination. Brown is 5.923 km and still
contains 371 m tagged fine gravel and 65 m wood, plus 507 m unknown surface.
The corrected start eliminates the forced woodland opening, not all surface
concerns. Brown is not a verified paved alternative and no new route has been
rider-approved. Metrics are in `.local/thal-corrected-start-summary.json`.

The original start, routes and feedback are preserved in their saved snapshots.
Rejection labels match the original geometry only; they do not transfer a rider
judgment to a changed route. The known unpaved tags on the new brown route still
require attention before any profile is promoted. Validation passed 19 Node
tests, the isolated build and browser checks for the rejection labels.

## Corrected Thal Automatic rider feedback, 2026-10-18

For revision 2 run `2026-10-18T17-04-18-100Z-16055074`, the rider says
GraphHopper and ORS look good and questions brown's deviations as possibly
offroad. Record green and blue as positive qualitative reference candidates,
not independently verified paved/safe routes. Brown remains unaccepted; the
rider has not identified exact boundaries for every questionable deviation.
Feedback is in `.local/feedback/04-thal-revision-2-automatic-2026-10-18.json`.

Saved BRouter messages identify two cycleway intervals tagged fine gravel,
189 m and 182 m. Both receive a reported cost of 1100 per km, confirming that
these unpaved cycleways receive a low routing cost in this candidate. This
supports the rider's concern but does not establish which exact deviations
they were pointing to. About 503 m of the destination approach remains unknown
in green/blue's surface data. Their sampled geometries agree within about 1 m.

Detailed interval locations and geometry comparisons are saved in
`.local/thal-revision-2-route-comparison.json`. Do not confuse geometric
separation with unwanted-road distance or infer a measured correction count.
Use these green/blue reference candidates to test surface-aware changes while
retaining the previously accepted Mur, Eggenberg and western Graz routes.
No routing settings changed in response to this review; the existing broad
surface penalty probes remain unpromoted because of their regressions.

## Thal cycle-path clarification, 2026-10-18

The rider clarified that brown follows the cycling path, whose longer gravel
sections are the problem. Do not describe the whole cycling path as invalid
or infer that cycle paths are generally undesirable. For this road-cycling
case, a cycleway or signed-network preference must not outweigh unsuitable
long gravel sections when a suitable paved alternative exists. The earlier
positive green/blue assessment remains the reference for this route.

The clarification is saved in
`.local/feedback/04-thal-cyclepath-gravel-clarification-2026-10-18.json`.
No numerical acceptable-gravel threshold was supplied. Keep the rider's
explicit short temporary Mur construction exception separate from this
long-gravel rejection. Routing settings are unchanged pending a tested fix.

## Surface-aware candidate v4, 2026-10-18

`surface-v4` retains the traffic and cycle-network preferences of `traffic-v3`
and adds a cost of 3 per metre for explicitly loose surfaces, including fine
gravel and compacted. That cost combines with the existing access and wrong-way
penalties using the maximum, rather than adding a second penalty when dismount
or access already costs more. Access restrictions are not relaxed. Unknown
surface remains unknown; wood is not classified as a loose surface.

This is a distance-based preference, not a strict paved-only guarantee or a
maximum gravel-length rule. Longer loose sections accumulate more cost. The
61 m Mur construction/dismount section keeps its previous cost and warning.
This does not grant general permission to ride dismount or closed sections.
The earlier additive surface probes changed that accepted Mur route; they
remain preserved and unpromoted. The new probe cost 1.5 retained Thal's gravel,
while 3 and 4 avoided it; 3 is the lowest tested successful value.

[Review Thal Automatic with surface-v4](http://127.0.0.1:5174/?case=04-thal-surface&variant=automatic&run=2026-10-18T17-16-09-220Z-71b485dc).
Brown now returns 5.888 km, avoiding both fine-gravel intervals totalling 371 m.
Its messages report 5,341 m asphalt, 43 m wood and 504 m unknown surface.
These tag-based distances do not establish current surface conditions. It
still differs from green on short nearby sections and awaits rider review.
The unreviewed draft Chosen roads variant is not a validated paved route.

| Case | surface-v4 saved run | Regression result |
| --- | --- | --- |
| 01 Mur north | `2026-10-18T17-16-22-502Z-b6a9b42f` | Automatic retains the accepted composite reference. |
| 02 parallel Mur | `2026-10-18T17-16-23-154Z-53c51622` | Automatic retains the accepted route. |
| 03 Eggenberg | `2026-10-18T17-16-23-863Z-cf312ae6` | Automatic and Chosen roads retain the accepted route. |
| 04 Thal revision 2 | `2026-10-18T17-16-09-220Z-71b485dc` | Automatic avoids mapped loose surfaces; rider review pending. |
| 06 western Graz | `2026-10-18T17-16-24-332Z-8ce416be` | All three BRouter variants have identical geometry to the prior accepted comparison. |

GraphHopper and ORS Thal geometries are unchanged. Checks passed against saved
Mur, Eggenberg and western Graz references, plus 19 Node tests and the isolated
build. Held-out scenarios remain blocked for this experimental setting. No
paid service, model call or hidden shaping point was introduced. Earlier
profiles and comparisons are unchanged. Probe evidence is in
`.local/surface-max-probes/`; checks are in `.local/surface-v4-checks.json` and
`.local/surface-v4-surface-checks.json`.

```powershell
node experiments/routing/check-automatic.mjs 2026-10-18T17-16-23-863Z-cf312ae6 2026-10-18T17-16-23-154Z-53c51622 2026-10-18T17-16-22-502Z-b6a9b42f
node experiments/routing/check-surfaces.mjs 2026-10-18T17-16-09-220Z-71b485dc 2026-10-18T17-16-24-332Z-8ce416be
```

## Remaining Thal deviation: narrow path and road continuity, 2026-10-18

The rider reviewed surface-v4 Automatic in
`2026-10-18T17-16-09-220Z-71b485dc`. The remaining brown deviation follows a
generally paved cycle path, but the rider prefers the main road because the
path is very narrow and joins the road again anyway. Green/blue remain the
preferred reference candidates here. Removing the mapped gravel was useful,
but surface-v4 has not yet reproduced this route preference.

Feedback is saved in
`.local/feedback/04-thal-surface-v4-narrow-cyclepath-2026-10-18.json`.
No numerical width, precise deviation boundaries or acceptable path length
was supplied. The saved BRouter messages and installed lookup vocabulary do
not expose width/narrowness fields; this does not prove those tags are absent
from raw OSM. Do not fabricate width or equate all shared paths with narrowness.

Future tuning should test whether the benefit of leaving a suitable road
justifies a road/path transition, and distinguish narrow interrupted paths
from the wide continuous Mur paths the rider preferred. Preserve those earlier
preferences in regression checks. No global main-road preference or new cost
setting was introduced by this feedback alone.

## Road/path transition investigation and explicit Thal selection, 2026-10-18

General transition penalties can remove the remaining Thal cycle-path deviation,
but none of the tested rules does so while retaining every accepted route.
With a cost of 300 on entering and leaving paths, Thal matches green within
0.54 m. However, western Graz Chosen roads and After an edit leave about 124 m
of the previously accepted cycleway for the adjacent secondary road. Maximum
geometric separation is only 6.63 m, but that is a meaningful route change.
Entry-only penalties of 450 and 600 have the same drawback. Rules restricted
to major roads or unsegregated shared paths introduce additional regressions.
None became a public profile; `surface-v4` is unchanged.

The first classifier experiment used zero for roads and therefore did not
activate transition costs. It is diagnostic evidence, not a successful test.
The pinned [BRouter implementation](https://github.com/abrensch/brouter/blob/v1.7.10/brouter-core/src/main/java/btools/router/OsmPath.java)
requires both consecutive classifier values to be nonzero. Active probes use
nonzero classifiers and retain their requests, profiles, responses and measured
regressions in `.local/continuity-active-probes/`,
`.local/mainroad-transition-probes/`, `.local/entry-transition-probes/` and
`.local/shared-path-probes/`.

A local PBF audit found the relevant Thal cycleways tagged `segregated=no`,
with asphalt and short wooden bridges, but no width measurement. This does not
establish width elsewhere or equate shared paths with narrow paths. The audit
source and output are `.local/ors/InspectWays.java` and
`.local/ors/thal-way-tags.txt`. It used the existing local data, with no hosted
API or service charge. Width-sensitive automatic routing remains unresolved.

Scenario 04 revision 3 corrects the old draft Chosen roads point. It now uses
two visible shaping points on the rider-preferred Thalstraße line:
`[15.378424, 47.099507]` and `[15.37562, 47.097028]`. A single point did not
reliably retain the entire desired section; probes are saved in
`.local/thal-main-road-selection-probes.json`. Start and destination stay the
same. These points apply only to Chosen roads, never to Automatic.

[Review the explicit main-road selection](http://127.0.0.1:5174/?case=04-thal-surface&variant=selected&run=2026-10-18T17-42-08-526Z-3d95a316).
All six requests succeeded. Brown Chosen roads is 5.883 km and matches the
reviewed green Automatic geometry within 0.54 m, without added backtracking.
Green and blue retain their own main-road lines. Their small mutual geometry
differences reflect the saved responses; they are not new route preferences.
All three Automatic geometries are identical to revision 2, including brown's
unresolved deviation. This is a deliberate-selection result, not an automatic
routing fix. No new rider acceptance is inferred.

Validation passed: 19 Node tests, the isolated build, browser checks for both
visible road points and reload preservation, and
`node experiments/routing/check-road-selection.mjs 2026-10-18T17-42-08-526Z-3d95a316`.
The original runs and existing accepted profiles remain available.

On 2026-10-19 the rider observed that all three revision 3 Chosen roads routes
are on the same track. This confirms visible overlap in the linked comparison;
it is not a claim of identical coordinate arrays or an Automatic routing fix.
The observation is saved in
`.local/feedback/04-thal-revision-3-selected-2026-10-19.json`.
No additional rideability approval or engine preference is inferred.

## Review of the earlier editor snapshot, 2026-10-19

An earlier editor snapshot and its accompanying notes were reviewed before
integration.
Archive SHA-256:
`49a74f771acb2508bedaf1ef5d367c9c57312665704303d20a57aa152f3a46a8`.
The source was extracted into the ignored
`.local/external-review-2026-10-19/` directory, excluding its `.git` directory.
The working application, engine configurations, profiles and saved rider runs
were not replaced. No services were provisioned or dependencies downloaded.

The archive is useful parallel work. Its editor implementation is further along
than our original application, while our experiment contains rider feedback and
tuned profiles absent from that snapshot. A newer archive date is not a reason
to replace either body of work.

### Work worth reusing

- `src/domain/route-model.ts` uses stable point IDs and retains unchanged leg
  objects. `LegScheduler` cancels obsolete requests and also rejects late replies
  from an engine that ignores cancellation. This addresses concrete defects
  identified in our original editor. Adopt this approach when integrating the
  chosen routing adapter, with our saved routes as regression evidence.
- The store implements undo/redo with point and geometry snapshots, and failed
  legs remain explicit straight lines. The 13 supplied tests passed here. They
  cover core leg logic, stale responses and comparison parsing; they do not
  establish full browser behavior, store-level undo races or riding suitability.
- Its application build passed using the dependencies already installed in this
  workspace, with the large-bundle warning. This was not a clean dependency
  installation or a browser acceptance test. It does not change the build status
  of our original application.
- Keep Vue/TypeScript/MapLibre. There is no demonstrated need for a framework or
  Rust rewrite. The proposed loop candidate scoring and storing shared route
  geometry rather than silently rerouting it are useful future design ideas.
- OpenFreeMap is a useful candidate for a free vector basemap. Its official site
  permits commercial use and lists no map-view/request quota, but offers no SLA.
  This is not a replacement for aerial imagery. See [OpenFreeMap](https://openfreemap.org/).

### Claims and implementation limits

The report's conclusion that BRouter is the only viable choice follows from
unmeasured Europe-scale hosting assumptions, not a controlled route-quality
comparison. Our present scope is local Graz/Styria. Retain GraphHopper and ORS
as comparators and keep the engine decision open. Likewise, the ORS 10.1.0
[POM](https://raw.githubusercontent.com/GIScience/openrouteservice/v10.1.0/pom.xml)
does pin its GraphHopper fork to `v4.16.0`, but that version number does not prove
inferior routes. [ORS documentation](https://giscience.github.io/openrouteservice/api-reference/endpoints/directions/custom-models)
confirms that custom models are experimental, self-hosted features rather than
public-API options. We already run local ORS, and the rider preferred its Thal
line over the remaining brown deviation.

Per-leg preservation solves unwanted changes elsewhere; it does not by itself
solve turns at leg boundaries. The supplied `routeLeg(from, to)` adapter sends
independent two-point requests without incoming direction or pass-through
context. Its preliminary `/nearest` snap is not cycling-profile-specific.
Before adoption, test parallel carriageways, cycleway entrances, U-turns and
joins against actual engine responses. The archived comparison concatenates
legs by dropping every later leg's first point without checking endpoint
agreement. No join gap above 0.1 m occurred in the supplied run, but this remains
an assumption to validate for new requests. Its adapter also requests elevation;
our current GraphHopper graph was built without it.

The saved comparison contains 36 scenario/profile results and 54 successful
individual leg requests, rather than 36 HTTP requests. All 12 scenarios remain
unreviewed and differ from our rider-reviewed set. The saved JSON files have no
`review` object, despite the handoff saying its fields are null; the supplied
runner now adds those fields. Preserve the raw files and record this provenance
difference. GraphHopper used a different PBF and elevation configuration, and
BRouter used stock profiles and another tile fingerprint. Do not mix these
measurements with our tuned-profile scores or treat them as held-out validation.

The proposed cloud stack does not remove quota-dependent availability.
[Oracle's current documentation](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)
confirms the cited 2 OCPU/12 GB allowance and possible idle reclamation.
[Cloudflare D1](https://developers.cloudflare.com/d1/platform/pricing/)
returns errors when free daily query limits are exhausted. No cloud migration
is selected; additional service charges remain EUR 0 on the existing machine.
MapLibre 6.15.0 is a real
[release](https://github.com/maplibre/maplibre-gl-js/releases/tag/v6.15.0),
but upgrading is separate compatibility work and does not improve routing costs.
Other pricing, legal, mobile and Europe-capacity claims were not exhaustively
verified in this review and are not adopted as requirements or guarantees.

### Effect on the next work

Use the archive's stable-ID leg model as the starting point for the later editor
integration, preserving our comparison UI and rider evidence. Keep its loop,
geocoding and elevation research as candidates for subsequent measured work.
It supplies no validated fix for the narrow Thal path. Our Automatic result
remains unresolved, and revision 3 Chosen roads still awaits the rider's review.
Neither a higher blanket cycleway preference nor a blanket road preference
expresses the distinction between that path and the preferred wide Mur path.

## Scenario 05 endpoint audit and next rider review, 2026-10-19

The original draft destination snapped to a gravel track. The original start
also introduced service-road/path approaches of uncertain suitability. Run
`2026-10-19T17-57-28-525Z-f3b30ff9` preserves the original three-engine result;
do not attribute its forced unpaved finish to a failure to avoid a shortcut.

Revision 2 puts the start on mapped asphalt on Hahnhofweg
`[15.474345,47.090869]` and the destination on mapped asphalt on Roseggerweg
`[15.503735,47.105271]`. The old draft shaping point is replaced by a mapped
asphalt point on Eckmichlstraße `[15.509557,47.102374]`. These are inferred
placements requiring rider review, not rider-approved locations. The case ID
stays stable, while its title now names the actual roads.

New run `2026-10-19T17-58-35-647Z-3959e58a` uses surface-v4 and local ORS.
All six requests succeeded. Automatic distances are GraphHopper 4.362 km,
BRouter 4.371 km and ORS 4.360 km, with asphalt reported throughout by all
three engines. This is map-tag evidence, not field verification. The endpoint
correction changes the test, so distance and surface changes must not be
presented as a profile improvement. No engine settings changed.

[Review Automatic from Hahnhofweg to Roseggerweg](http://127.0.0.1:5174/?case=05-mariatrost-climb&variant=automatic&run=2026-10-19T17-58-35-647Z-3959e58a).
Browser verification confirmed revision 2, Automatic, two endpoints and three
route rows. First ask whether the endpoints and road corridor are sensible.
GraphHopper and ORS still have elevation disabled, so this cannot establish
which engine handles climbing preferences better.

The rider subsequently accepted both endpoints and the shared Automatic route:
"no, 1 and 2 are just fine. i would choose exactly the same route."
Acceptance is saved in
`.local/feedback/05-hahnhof-rosegger-revision-2-automatic-2026-10-19.json`,
with geometry fingerprints for all three candidates, and in three review records
under the saved run. Retain these routes as accepted tuning references. No engine
preference, measured correction count or climbing-performance verdict is inferred.
The Chosen roads shaping point remains unreviewed.

## Critical comparison of the two editors, 2026-10-19

The user requested an assessment of efficiency, redundancy and unnecessary
abstraction before adopting the other implementation. The verdict is narrower
than "the new code is better": its point/leg architecture is a better foundation
for the required editor behavior, but neither implementation should be shipped
unchanged. Our isolated engine experiment and rider evidence are separate from
the original editor and should remain authoritative for routing comparisons.
This audit changed no application source, engine settings or dependencies.

### Reproduced behavior

The local audit script `.local/editor-code-audit.mjs` bundles each actual Pinia
store with mocked routing/geocoding services. It exercises the store logic with
controlled response ordering and makes no network requests. Results are in
`.local/editor-code-audit-results.json`. Run it from the repository root with
`node experiments/routing/.local/editor-code-audit.mjs`.

| Area | Current editor | Supplied editor | Decision |
| --- | --- | --- | --- |
| Shaping-point identity | A shape with geometry index 21 between two stops disappears from the outgoing point list. The drag code produces geometry indices, but the store expects stop-pair indices. | Stable point IDs and leg endpoints avoid that mismatch. | Reuse the ordered point/leg model. |
| Late responses | Resolving the newer request first and the older request last leaves the older route displayed. | Controller identity checks protect against a response arriving after cancellation; covered by the supplied tests. | Keep cancellation and stale-result checks. They are necessary behavior, not excess defensive code. |
| Undo during snapping | No comparable route-history implementation. | Move a stop, add an empty intermediate stop while its snap is pending, then undo the insertion. Undo cancels the snap and does not restart it; the restored marker stays at the unsnapped coordinate, and routing resumes from that coordinate. Routing may snap internally, so this does not prove the resulting road is invalid. | Fix before adoption; history must restore or resume pending point operations consistently. |
| Request concurrency | Whole-route requests repeat; a new throttle is created inside each call, so it does not throttle separate calls. | A synthetic 41-point route starts 40 unresolved leg calls immediately. | Use a small concurrency bound appropriate to the local engine. This observation is not a latency benchmark or proof of failure at 40 legs. |
| Map geometry | Creates one feature per coordinate pair. | Creates features per surface span within a leg. For the same synthetic 10,000-point, single-asphalt-leg input: 9,999 versus one feature. | Reuse span-based rendering. This measures allocations/output structure, not frame rate. |

The current root build was rerun and failed with 14 TypeScript diagnostics,
including the undefined `till` return member in `useMapMarkers.ts`, obsolete panel
calls and unused declarations. Preserve existing user changes while repairing
them later. The supplied editor's 13 tests and build passed during the earlier
archive assessment using our installed dependencies. Its tests do not import
the actual store or exercise undo/redo, snapping races or browser interactions;
passing them did not expose the reproduced undo defect.

### Integration risks and redundant code

The supplied adapter is hardcoded to GraphHopper racingbike, asks for elevation
and uses profile-independent `/nearest` snapping before routing. It is not a
drop-in adapter for our three engines or the current no-elevation graph. Its
two-point leg interface also has no incoming direction or pass-through context.
Continuity at cycleway entrances, divided roads and junctions needs actual
engine tests before promising that independent leg requests preserve legal,
sensible turns. These are limitations identified in code, not newly reproduced
route failures.

The archive retains dependencies without current source imports, including
`axios-retry`, `lodash`, `@turf/turf` and `vue-draggable-plus`, and an unused Axios
service wrapper. Its active startup still registers PrimeVue's theme, toast
service and global progress spinner, while the replacement editor uses native
controls and inline errors. Check the reachable import graph and remove unused
registrations when integrating. Installed unused packages are not necessarily
present in the browser bundle; do not infer bundle savings from package names.
Our current tree also contains multiple old route stores and map/service files.
Consolidate only after checking imports, preserving the user's work.

The archive's comparison parser duplicates routing response handling, and even
its surface categories diverge: the editor calls wood rough while the comparison
parser treats it as unknown; `sett` differs in the opposite direction. Keep one
surface classification policy within the integrated app, and retain raw tags
for review. Do not import a second comparison UI alongside ours.

Validation of external routing/geocoding payloads is appropriate. Small pure
functions and a scheduler have clear responsibilities here. Do not introduce a
generic plugin registry, event bus, routing framework or schema library merely
to reorganize this code. The goal is one point sequence, one leg model, one
store owning edits/history and a small local routing adapter. Fix the proven
race and concurrency gaps, retain unchanged leg geometries, and test against
our accepted routes before expanding the UI. Profile full-route serialization
and elevation rendering before attempting more elaborate incremental rendering.

## Local editor integration, 2026-10-19

The user authorized selective reuse of the external editor after the critical
audit above. The active root app now uses one ordered point list, one leg model
and one Pinia store. Vue, Pinia and MapLibre remain the runtime dependencies.
Unused legacy source was archived after checking the reachable import graph.
The complete pre-integration source, including uncommitted files and marker
changes, is preserved under `.local/editor-before-integration-2026-10-19/`.
No Git commit, push, pull or reset was performed.

The editor calls local BRouter with `richi-surface-v4` through a same-origin Vite
proxy. Routing and preliminary snapping use the same profile. Outer endpoints
retain the original click until the actual route establishes the reachable
endpoint. This matters: feeding the preliminary snap back as the requested start
initially changed the accepted Mur and Western Graz openings. Retaining the
original click restored all six checked reference geometries. Intermediate
points must join within two metres; a different road produces a dashed error
section instead of an invented connector.

Undo/redo resumes interrupted snaps and restores completed leg geometry. Late
responses cannot overwrite newer edits. Forty queued legs and ignored aborts
remain bounded to two active routing jobs; snapping and routing also share a
two-request HTTP limit. Failed snaps do not route from raw coordinates. Edits
replace only adjacent legs. Whole-route optimization recalculates every leg
through the existing points; it does not reorder stops.

Surface rendering groups contiguous spans instead of creating one feature per
coordinate pair. One parser handles BRouter surfaces, elevation and malformed
responses. Unknown or unmatched surface spans remain unknown. The existing
comparison and its normalization remain separate, with their original evidence.

Street and labelled aerial backgrounds share the existing basemap.at definitions
with the comparison. Local roads come from GraphHopper. Route rendering no longer
waits for background tiles to finish: failed imagery does not hide the route.
The UI includes surface colours, elevation, map switching, route fitting, retry,
undo/redo and a Hahnhofweg–Roseggerweg example. Optional Photon address search is
not installed; map-based planning works without it. Editor drafts were initially
in memory. Automatic browser persistence and GPX export were added on 2026-10-20;
see the root README for current behavior.

Validation:

- 21 editor regression tests and the existing 19 comparison tests pass. Both
  production builds pass. The MapLibre-containing bundle still triggers Vite's
  size advisory, approximately 1.03 MB minified / 290 KB gzip for the editor.
- `tests/editor-local-check.mjs` checks surface-v4 Automatic cases 01, 02, 03
  and 05, plus case 06 Chosen roads and After an edit. All six reproduce the
  reference geometry and distance, with no sampled deviations beyond three
  metres and no length difference. These are integration regressions, not new
  rider approvals or held-out evaluation results.
- Twelve warm local edits on the existing desktop took about 93 ms median and
  95 ms p95 from store action to completed routing, including a 5 ms polling
  interval. Each used one snap and two leg requests; distant leg objects stayed
  unchanged. This is not a multi-user capacity test or a browser frame benchmark.
- A synthetic 10,000-vertex asphalt leg becomes one GeoJSON feature. Preparation
  measured roughly 0.004 ms median / 0.010 ms p95 in Node over 200 iterations.
  This measures only conversion, not map upload, elevation layout or total frame
  time; it is not evidence of a comparable end-to-end speedup.
- Chrome tests passed live routing, street and aerial tiles, line and marker
  dragging, undo/redo, distant-section preservation, 390 px mobile layout,
  blocked-imagery rendering and switching to local roads. No page errors.
  Browser tile access needed an approved run outside the network sandbox.

Private evidence is in `.local/editor-local-check.json`,
`.local/editor-browser-results.json` and the `editor-*.png` screenshots.
The reproducible scripts are `tests/editor-local-check.mjs` and
`tests/browser-editor.mjs` at repository root. They require existing local data
and services; ordinary `npm test` requires neither Docker nor network access.

Keep the engine local and replaceable. The measured work uses the existing
routing engine. Additional service charges remain EUR 0. This does
not settle Thal Automatic, guarantee paved-only routes, validate every possible
turn across independently routed legs, or establish capacity for hundreds of
users. Continue the independent evaluation before declaring a final engine
winner. Production hosting and proxies have not been deployed.

## Riesstraße–Stiftingtalstraße bicycle turn, 2026-10-19

The rider reported an overshoot and turnaround at the junction near
Schillingsdorf, then confirmed: "it is allowed to turn left here."
Local OSM relation 1597055 encodes `no_left_turn` without a bicycle exception.
Its note mentions a signed cycle route through the turn. A reproduction using
two shaping coordinates estimated from the screenshot produced the same service
road loop. It was inside a single BRouter leg, not at an editor section join.
BRouter and ORS followed the restriction; GraphHopper used the direct turn.

The local BRouter `ries-bicycle-turn-v1` patch adds only the bicycle exception
bit for the exact negative restriction at via node 26017964, from way 114442695
to way 24469315. It matches the encoded via/from/to coordinates. The stock JAR,
RD5, profile settings, ORS graph and public OSM data remain unchanged. The patch
is based on the rider's local report, not independently verified traffic signs.
The active Compose service uses the separately built patched JAR. See
[build instructions and scope](brouter-patch/README.md).

With turn restrictions enabled, the affected leg is now 4,898 m instead of
5,158 m. The full screenshot reproduction is 9,867 m instead of 10,127 m. Its
shaping coordinates are approximate, so these totals need not exactly match the
rider's tab. Browser inspection confirms the direct turn and no service-road
loop. Thirteen Java scope assertions check the bicycle exception, unchanged
motorcar restriction, other nodes/directions, positive restrictions and existing
exception bits. All six reference geometries remain unchanged; the 19 benchmark
tests, benchmark build and editor browser checks pass.

New benchmark runs record the patch ID, source snapshot and verified JAR hash.
Earlier runs retain their original provenance and geometry. The regression
`node tests/ries-junction-local.mjs` must be rerun after map updates. Changed
coordinates deliberately stop matching the exception and require review.
Private investigation and rider confirmation are saved in
`.local/feedback/ries-stiftingtal-junction-2026-10-19.json`.
Current editor tabs can recalculate with **Gesamte Route optimieren**; a page
reload was unnecessary and would discard the draft at the time of this fix.
Automatic draft restoration was added on 2026-10-20. EUR 0 additional
service charges. No commit, push or public map edit.

## Thal local preference preview, 2026-10-19

**Accepted and enabled, 2026-10-20.** The rider confirmed "didnt we already review
that??? all same route and good". The main editor now includes the same finite
weight as the comparison. Both read `src/config/thal-preference.json`; new runs
snapshot this file. The accepted Automatic view is marked as reviewed, without
altering saved run evidence or extending acceptance to future runs. No repeat
rider review is required. This supersedes the preview-only status below.

`node tests/thal-editor-local.mjs` verified 5.883 km in both directions through
the editor service, the 66 m short cycle-path trip, unchanged snapping, inserting
a path shaping point in the store and undoing it back to the main road. All twelve
comparison reference variants and six editor references remain unchanged. Unit
tests and both builds passed; the existing bundle-size warnings remain.
Feedback is saved in `.local/feedback/04-thal-local-accepted-2026-10-20.json`.

`thal-local-v1` is a comparison-only candidate. It retains `surface-v4` and adds
a finite BRouter avoidance weight at `[15.377673, 47.098973]` on the narrow path
identified in the rider's Thal feedback. Its 5 m radius selects that mapped
path, not the adjacent road; it is not a measured path width. Weight 50 adds
about 500 distance-cost units when crossing the full circle. This expresses a
local route preference, not a closure, access restriction or general main-road rule.
The main editor still requests plain `surface-v4`.

[Review Automatic with the local preference](http://127.0.0.1:5174/?case=04-thal-surface&variant=automatic&run=2026-10-19T21-01-39-289Z-2152b0bd).
Only the start and destination are supplied. Brown is 5.883 km and matches the
preferred GraphHopper main-road line within 0.54 m. The reverse direction also
matches. All six requests in the saved comparison succeeded. The request and
profile snapshot record the preference, while earlier runs retain their settings.

`node experiments/routing/check-thal-local.mjs` checks twelve saved BRouter
variants, with identical coordinate arrays, plus both Thal directions, an explicit
cycle-path point, a 66 m trip on the path and the corrected Ries junction. These
are regression checks against local fixtures, not new rider acceptance. The
comparison tests pass 20/20 and its build passes with the existing bundle warning.
Browser checks confirmed the linked Automatic view, three routes, two endpoints
and reload preservation. Evidence is under `.local/thal-local-probes/`.

The user has been asked whether to remember this local preference or retain a
manual edit. It has not been enabled in the editor. If adopted, keep its rider
provenance and recheck the location after map updates; this does not supply missing
width data or solve route choice elsewhere. No public OSM tags were changed.

The preceding wooden-surface experiment is not promoted. Extra costs of 1, 3 and
6 retained roughly 487 m of the deviation; cost 10 removed it, but would penalize
wooden bridges elsewhere for a complaint about this path's narrowness. The source,
responses and measurements are in `.local/probe-wood.mjs` and `.local/wood-probes/`.
Buffered polygon probes were also discarded. The pinned implementation checks
boundary intersections, so a route segment contained entirely inside the corridor
does not reliably receive that polygon's cost.

The preview uses BRouter's existing [weighted avoidance parameter](https://github.com/abrensch/brouter/blob/v1.7.10/brouter-server/src/main/java/btools/server/request/ServerHandler.java)
and its [local cost calculation](https://github.com/abrensch/brouter/blob/v1.7.10/brouter-core/src/main/java/btools/router/RoutingContext.java).
No new library, service or engine patch is needed. Additional service charges remain EUR 0.

## Source references

- [GraphHopper 11.1 configuration](https://github.com/graphhopper/graphhopper/blob/11.1/config-example.yml)
- [GraphHopper racing-bike model](https://github.com/graphhopper/graphhopper/blob/11.1/core/src/main/resources/com/graphhopper/custom_models/racingbike.json)
- [BRouter 1.7.10 fastbike profile](https://github.com/abrensch/brouter/blob/v1.7.10/misc/profiles2/fastbike.brf)
- [BRouter server launch arguments](https://github.com/abrensch/brouter/blob/v1.7.10/misc/scripts/standalone/server.sh)
- [Styria PBF](https://download.openstreetmap.fr/extracts/europe/austria/steiermark.osm.pbf)
- [Prepared BRouter tile](https://brouter.de/brouter/segments4/E15_N45.rd5)
- [OpenRouteService 10.1.0](https://github.com/GIScience/openrouteservice/releases/tag/v10.1.0)
- [ORS surface codes](https://giscience.github.io/openrouteservice/api-reference/endpoints/directions/extra-info/surface)
- [OpenStreetMap attribution and licence](https://www.openstreetmap.org/copyright)
- [basemap.at free-use terms and attribution](https://basemap.at/#nutzungsbedingungen)
- [basemap.at aerial imagery](https://basemap.at/orthofoto/)
- [basemap.at street-label overlay](https://basemap.at/overlay/)
- [WMTS tile templates](https://mapsneu.wien.gv.at/basemap/1.0.0/WMTSCapabilities.xml)
