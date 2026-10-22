# Local bicycle corrections

The active build is `local-bicycle-v2`. It retains the Ries turn correction and
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
