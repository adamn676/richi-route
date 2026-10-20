# Local bicycle turn correction

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

Build with `npm run bench:brouter:patch`, then restart with
`docker compose -f experiments/routing/compose.yml up -d --no-build --pull never brouter`.
The build reuses the already installed local ORS compiler image, pulls nothing,
and runs Java scope tests before producing a separate patched JAR and hash
manifest in `.local/brouter/`. The application request format stays unchanged.

After map updates, run `node tests/ries-junction-local.mjs`. Changed coordinates
stop matching, so the exception will need review instead of silently applying to
another road. The check also ensures restrictions remain enabled elsewhere.
Saved benchmark records retain their original results; new runs record this
engine patch. No public map edit is performed.
