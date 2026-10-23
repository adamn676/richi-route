# Local bicycle corrections

The native launcher now uses the configurable rules engine. Its location data
comes from [`config/routing-rules.json`](../../../config/routing-rules.json).
Weidweg, Ries and Thal are entries in that file. The Java integration contains
no location names or coordinates. The bicycle-v2 sources below remain as the
historical baseline used by the preserved benchmark bundle.

## Configurable local rules

For the first build, run `npm run bench:brouter:performance`, followed by
`npm run routing:build`. The native launcher prepares the rules and profile
before starting the engine. It checks the compiled integration against its
source manifest, then loads `brouter-local-rules.jar` ahead of the preserved
base JAR. The new JAR includes the measured cache and distance optimizations.

To add another location, edit the shared JSON, run `npm run routing:prepare`,
restart the native launcher, then run `npm run routing:check`. This changes
configuration and generated artifacts, without compiling Java. The compiler
also generates the browser's notices and policy revision. Do not edit
`src/config/routing-rules.generated.json` or the generated TSV/profile by hand.
Rebuild a production frontend after preparation so it includes the new revision.

| Kind | Match | Effect |
| --- | --- | --- |
| `passage` | Directed RD5 link endpoints, required/forbidden/absent tags, bicycle mode and profile opt-in | Replace the otherwise excluded cost of 9999 with the configured finite cost; retain original tags and show the configured notice |
| `turn` | Exact incoming point, junction and outgoing point of a negative restriction | Add a bicycle exception for that request, preserving other restrictions and modes |
| `avoidance` | Circle center and radius | Apply the configured finite BRouter avoidance weight |

Each entry needs a unique ID, `enabled`, `mode: "bicycle"`, review date, reason
and checksums of the reviewed RD5 tiles containing its coordinates. OSM way
and relation IDs are reference metadata. Matching uses the encoded RD5 graph
coordinates, not those OSM IDs. Passage coordinates must be exact graph-link
endpoints; links with intermediate geometry do not qualify. `direction` can
be `forward` or `both`. New behavior types require implementation and tests;
new locations of these existing types need only data.

The compiler rejects duplicate segment/turn matches, unsupported fields and
types, contradictory tag guards, unsupported lookup tags/values, invalid
coordinates and missing tile reviews. A changed reviewed tile stops preparation
and names the affected rules. Review the changed geometry and access tags before
updating the checksum. This deliberately requests review for any change in the
tile; it does not silently attach an old exception to a nearby road.

The engine loads an immutable snapshot once at startup. Passage and turn
lookups use primitive hash indexes. Avoidance circles use a bounding-box tree
and a bounded cache of spatial cells for each request. Tag prefiltering reuses
distinct guard patterns instead of scanning all locations. Normal routing
performs no file reads. A long segment falls back to the tree so the cell cache
cannot omit crossed areas.

Avoidance penalties retain BRouter's ordering: when several configured circles
match the same section, the last matching entry in the configuration wins.
An explicit blocking request nogo takes precedence. Deliberately placing a
waypoint inside a preference circle excludes that circle for the request, as
before. The current types do not provide hard area closures or turn prohibitions.

`richiroute_local_rules=0` opts out of all local rules. They also remain inactive
for car, foot and mixed modes. Turn corrections copy matching restriction lists
inside the request rather than mutating shared graph data. The ordinary BRouter
profile continues to determine general access, surface and hill costs.

Every editor request includes the full configuration digest, split into numeric
parameters supported by BRouter. The engine checks the original parameter text,
without reducing the digest to float precision. A stale browser/server pairing
fails with a restart message. New route legs record their policy revision;
changed policies trigger recalculation while the saved geometry stays visible.
Drafts from the unchanged pre-migration policy remain reusable. Route notices
use a spatial index generated from the same enabled passage entries, including
direction and partial-segment handling.

The small `RouteServer` patch translates only the dedicated revision-mismatch
exception into HTTP 400. Its upstream v1.7.10 source URL and SHA-256 are pinned
in `rules/sources.json`; the builder verifies cached or downloaded bytes before
applying the patch. Other server exception handling stays upstream behavior.

Validation commands:

```sh
npm run routing:prepare
npm run routing:build
npm run routing:check
npm test
node tests/routing-rules-engine.mjs
npm run bench:check-reviewed
npm run routing:benchmark
```

The Java tests use a fixed regression fixture independent of the active rule
list. They cover original access guards, additional locations, directed rules,
profile/mode isolation, immutable turn restrictions, revision mismatches,
overlapping areas, waypoint exclusions and 100,000 indexed comparisons against
the original circle calculation. `routing:check` verifies active passage geometry,
tags and costs, directed turns, and mapped avoidance centers. Avoidance route
preferences also need their route regression; snapping the center alone cannot
prove the rider's preferred route.

`routing:benchmark` compares the previous optimized engine, the migrated rules,
and 1,000/10,000 additional synthetic rules on two long routes. All variants use
the same JVM, heap, search coefficients and map data, with JFR enabled. It asserts
identical complete route features after normalizing the generated profile name.
Reports and recordings go to `.local/local-routing-rules/`. Synthetic rules are
never activated in the editor.

Historical `weidweg-*` presets and the Docker bicycle-v2 build require their
historical engine. Use `local-rules-v1` with the current native engine.

## Historical bicycle-v2 baseline

The base build is `local-bicycle-v2`. It retains the Ries turn correction and
adds the accepted Weidweg push-through passage. Both corrections use exact RD5
coordinates; public map data and the original BRouter JAR remain unchanged.

## Weidweg ramped passage

The rider accepted the western-loop composite on 2026-10-21, including the two
short ramped stair flights on OSM ways 28589123 and 28589125. The exception applies
to those flights in both directions, with these encoded longitude/latitude pairs:

| Flight | From | To |
| --- | --- | --- |
| 28589123 | 15.397866, 47.102550 | 15.397832, 47.102537 |
| 28589125 | 15.397639, 47.102476 | 15.397607, 47.102466 |

`richi-weidweg-v1` retains surface-v4's costs and `allow_steps=false`, adds the
global opt-in `richiroute_weidweg_push`, and reads `ramp:bicycle` so BRouter keeps
that tag available. It does not lower stair costs itself. An unpatched engine
continues to exclude the stairs with this profile.

`BExpressionContextWay` makes qualifying ramp links available for examination.
`OsmPath` and `StdPath` apply a cost factor of 15 only when `WeidwegPassage` matches
both exact endpoints, there are no intermediate geometry points, the mode is
bicycle-only, and the profile opts in. Required tags are `highway=steps`,
`bicycle=dismount`, `foot=yes`, `ramp:bicycle=yes` and `surface=concrete`.
Explicit private/no access or vehicle tags and any way-level one-way tag reject
the exception. Changed coordinates or tags retain the original restriction.
Other stair links remain excluded even if they have identical ramp tags.

The cost factor is a local preference, not a walking-time estimate. Returned
tags still say steps and dismount. The editor uses this profile with the existing
Thal preference and displays “Weidweg: kurze Treppen mit Fahrradrampe. Bitte
schieben.” when the route uses either flight, including after draft restoration.
The whole western-loop composite remains an open target.

The three additional upstream files come from BRouter **v1.7.10**:

| File | Unmodified SHA-256 |
| --- | --- |
| [OsmPath.java](https://github.com/abrensch/brouter/blob/v1.7.10/brouter-core/src/main/java/btools/router/OsmPath.java) | `f21538165c9109135e80e1805660692253e8828aa8f6375c299cb8c5e11dece9` |
| [StdPath.java](https://github.com/abrensch/brouter/blob/v1.7.10/brouter-core/src/main/java/btools/router/StdPath.java) | `09c3afa3e0ea34cea5bfff6c65194c49abfceb6fe6195e683e28b7ca051fdd79` |
| [BExpressionContextWay.java](https://github.com/abrensch/brouter/blob/v1.7.10/brouter-expressions/src/main/java/btools/expressions/BExpressionContextWay.java) | `e77f4dd34a53142a2a3dcd6e0c726f91de66d0c523afd4de9287ff00ae309164` |

## Ries bicycle turn

The rider confirmed on 2026-10-19: "it is allowed to turn left here."
This refers to Riesstraße → Stiftingtalstraße near Schillingsdorf, at
15.539841, 47.103009. Local OSM relation 1597055 has `no_left_turn` from way
114442695 to way 24469315 through node 26017964, without a bicycle exception.
Its note also mentions a signed cycle route through the turn.

`OsmNode.java` is the BRouter 1.7.10 upstream file with one change in
`addTurnRestriction`: add the existing bicycle exception bit for this exact
negative restriction. It matches the via coordinate and directed from/to
coordinates stored in the RD5 tile. It preserves all other exception bits and
the restriction for motorcars. The original JAR, RD5, profiles, ORS graph and
public OpenStreetMap data remain unchanged. This is a local rider-reported
correction, not independent verification of the current traffic signs.

Upstream file:
https://github.com/abrensch/brouter/blob/v1.7.10/brouter-mapaccess/src/main/java/btools/mapaccess/OsmNode.java

Unmodified source SHA-256:
`4d5c377b7d4f4e419ab169ee993d7f90380b645c8c0d2be5333ecd9abb91f732`

## Build and check

On Windows, stop BRouter and any test instance using the v2 JAR before rebuilding
it, otherwise the running JVM locks the file. Use `docker compose -f
experiments/routing/compose.yml stop brouter` for the main instance.

Build with `npm run bench:brouter:patch`, then restart with
`docker compose -f experiments/routing/compose.yml up -d --no-build --pull never brouter`.
The build reuses the already installed local ORS compiler image, pulls nothing,
and runs Java scope tests before producing a separate patched JAR and hash
manifest in `.local/brouter/`. It also prepares `richi-weidweg-v1.brf` without
overwriting different profile content. The output files are
`brouter-local-bicycle-v2.jar` and `local-bicycle-v2.patch.json`; the v1 JAR and its
manifest remain available. The application request format stays unchanged.

Run `npm run test:weidweg-local`, `npm run bench:check-reviewed` and
`npm run test:editor-local` after activation. The passage check tests both
directions, opt-out behaviour, all 14 protected routes and retained dismount
tags. `node tests/browser-weidweg.mjs` checks the notice and draft restoration
using the existing local browser tools. The build's Java tests cover changed
endpoints, missing ramp tags, access restrictions and changed surfaces.

After map updates, run `node tests/ries-junction-local.mjs`. Changed coordinates
stop matching, so the exception will need review instead of silently applying to
another road. The check also ensures restrictions remain enabled elsewhere.
Saved benchmark records retain their original results; new runs record this
engine patch. No public map edit is performed.

## Performance overlay

`npm run bench:brouter:performance` builds a separate three-class JAR for the
prepared native Ubuntu bundle. It requires the JDK installed by `npm run
native:setup`, GNU `patch` and the checksum-verified bicycle-v2 base JAR next to
the checkout. `JAVA_HOME` and `BROUTER_BASE_JAR` can select explicit locations;
the base JAR must still match the recorded benchmark hash.

The build verifies the original BRouter 1.7.10 sources and the existing local
`OsmPath.java`, applies the patches in `performance/` without fuzzy matching,
compiles for Java 8 bytecode and runs reference comparisons before producing
`.local/brouter-performance/brouter-performance.jar` and `performance.patch.json`.
The manifest fingerprints the patches, test sources, builder, base and output
JARs. `node experiments/routing/brouter-patch/build-performance.mjs --verify`
checks them without downloading or compiling. The launcher runs that check.

The changes are:

- Reject a segment clearly outside an avoidance circle's bounding box before
  the detailed distance calculation. The same geographic scales are used,
  with an extra metre of margin; nearby segments still take the original path.
- Use an equivalent bit mask for power-of-two expression-cache bucket counts,
  retaining the original modulo operation for other sizes and the same eviction
  order.
- Return the ordinary way cost immediately when the Weidweg exception cannot
  apply. The exact endpoint, mode, profile, ramp and access guards are retained.

The Java reference tests compare 1.8 million cache operations and one million
geographic cases, including distances, avoidance costs, endpoint snapping and
mutated state. Full engine checks also reproduced all 51 saved route feature
hashes. Timing and rejected alternatives are documented in the
[routing experiment report](../README.md#runtime-and-search-optimization-22-october-2026).

The native launcher puts the overlay before the unchanged base JAR on the
classpath. To reproduce the old engine, omit the overlay and use the original
bundled Java. The Docker bicycle-v2 build remains available separately. Rebuild
and recheck the overlay when changing its sources or base engine; never replace
the saved reference geometry to make a check pass.
