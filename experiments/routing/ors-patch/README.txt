Local ORS 10.1.0 patch: missing-endpoint-v1

ORSOSMReader.java comes from the v10.1.0 release:
https://github.com/GIScience/openrouteservice/blob/v10.1.0/ors-engine/src/main/java/org/heigit/ors/routing/graphhopper/extensions/ORSOSMReader.java
Original download SHA-256:
a009164e5fc362549fa39db6715ee66901b6bbbe894184ed75d7486a205da7d4
The source retains its upstream LGPL-2.1-or-later notice.

The only source change is a null guard in recordEstimatedWayDistance.
The stock image crashes importing our Styria PBF because nodeData.getCoordinates
can return null for the first or last node. JVM exception logging located the
NullPointerException in that method. The patch logs the OSM way ID and leaves
the optional estimated_way_distance tag unset when an endpoint is missing.
It does not fabricate coordinates or change bicycle preferences or access rules.
The underlying reader still decides which existing segments can be imported.
The reason each endpoint is missing has not been independently audited.

Dockerfile compiles this one class against the exact dependencies bundled in
the pinned upstream image and replaces it in ors-engine-10.1.0.jar. It does not
download Maven dependencies. The runtime version API still reports 10.1.0;
engines.mjs separately declares the patch, and saved comparisons snapshot the
patched source and Dockerfile. The graph directory has a separate patch suffix
so failed stock imports are preserved and cannot be reused accidentally.

Reassess this patch when upgrading ORS. Do not present it as an upstream fix.
Validation and saved comparison IDs are recorded in ../README.md.
