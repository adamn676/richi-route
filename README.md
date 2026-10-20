# RichiRoute

A road-cycling route planner built with Vue, TypeScript and MapLibre.

The editor runs BRouter locally with the reviewed `richi-surface-v4` road-cycling
profile and the accepted local Thal main-road preference. Explicitly selecting
the adjacent path remains possible. No AI inference or hosted routing API is required. Additional service
charges remain EUR 0. Street maps and labelled aerial imagery use free basemap.at
tiles and require internet; the local-road background uses the existing
GraphHopper graph. No hosted ORS, MapTiler keys, subscriptions or deployment are used.

## Open the editor

With the existing regional engine data prepared and Docker Desktop running:

```powershell
npm.cmd run bench:up
npm.cmd run dev
```

Open http://127.0.0.1:5173/. Click **Beispiel: Hahnhofweg → Roseggerweg**, then
**Route zeigen**, or click the map to place a start and destination. Drag the
route to add a shaping point. Only adjacent sections recalculate; undo and redo
restore the previous geometry. **Gesamte Route optimieren** recalculates all
sections through the current points without reordering stops.

The profile prefers paved roads but is not a strict paved-only guarantee.
Surface colours distinguish rough, unpaved and unknown sections. Missing routing
appears as dashed straight lines, never as a confirmed road route.

Address search is optional and requires a local Photon service at port 2322.
It is not installed by this change. Map placement and routing work without it.
The current editor draft saves automatically in this browser at
`http://127.0.0.1:5173/`. It restores stops, shaping points, exact calculated roads,
surface spans and elevation after reopening. Completed legs do not reroute on
restore; interrupted snaps and missing legs resume. The save message reports
success or failure. A second tab pauses its saving when another tab changes the
draft, so it cannot silently replace that draft.

This stores one current route, not a route library or account sync. **Neue Route**
replaces the current draft with an empty one; undo is available during that session.
Undo history is not restored after reopening. Browser data clearing removes the
saved draft. The saved comparison runs and rider feedback remain separate.

**GPX herunterladen** downloads the calculated track and known elevation. It is
available once every point and leg is ready, including routes restored without
the routing engine running. It never exports dashed placeholders. Small gaps
between leg geometries remain separate track segments. The file follows
[GPX 1.1](https://www.topografix.com/GPX/1/1/); no device-specific turn instructions
are generated. Device import has not been tested on physical cycling computers.

The local BRouter build includes a rider-confirmed bicycle exception for the
Riesstraße → Stiftingtalstraße left turn near Schillingsdorf. On a fresh setup,
build it with `npm run bench:brouter:patch` before starting BRouter; this uses the
already installed local ORS compiler image without pulling images. See
[the patch notes](experiments/routing/brouter-patch/README.md) for scope, build
requirements and the regression check to rerun after map updates.

The dev server binds only to this machine. A production build needs equivalent
same-origin proxies for routing, optional geocoding and local map tiles; it is
not a hosted deployment.

## Open the comparison

From PowerShell in this repository, with Docker Desktop running:

```powershell
npm.cmd run bench:up
npm.cmd run bench:dev
```

Open http://127.0.0.1:5174/. Choose a scenario, then **Compare routes**.
Saved comparisons remain on this computer. Stops and shaping points are numbered
in route order. Use **Chosen roads** and **After an edit** to inspect shaping.
The map offers **Street map**, **Aerial + labels** and **Local roads** backgrounds.
The first two require internet access; Local roads works offline. Click a road for
its local routing attributes, or reduce route opacity to inspect the imagery.

For first-time setup, checks, saved results and limitations, see
[the routing experiment guide](experiments/routing/README.md).

## Checks

```powershell
npm.cmd test
npm.cmd run build
npm.cmd run bench:test
npm.cmd run bench:build
```

`npm run bench:check-reviewed` compares the local BRouter against the committed
rider-reviewed geometry. It protects 14 route variants and separately reports
the western-loop composite as a target that automatic routing has not yet met.
It requires the prepared local routing assets and BRouter service.
`npm run test:editor-local` checks the same 14 protected routes through the editor
store and service, then checks local edits. It requires BRouter and the editor
server; the route fixtures are committed, so historical private runs are not needed.
`node tests/browser-editor.mjs` exercises the live editor in Chrome using the
existing Playwright installation under `.cache/browser-tools`. It checks street
and aerial tiles, dragging, undo/redo, preservation of distant sections, mobile
layout and failed-imagery fallback. Its output and screenshots remain private.
`node tests/browser-route-files.mjs` checks restoration in a new browser context
with routing blocked, exact exported GPX geometry and elevation, mobile export,
cross-tab protection, malformed storage, quota recovery, exit flushing and clearing
a draft. It uses the local-road map and does not need online map tiles.

The previous editor, including uncommitted source changes, was preserved in
`experiments/routing/.local/editor-before-integration-2026-10-19/` before integration.
The active source now uses Vue, Pinia and MapLibre without the unused UI and
request libraries. See the experiment guide for the audit and integration evidence.

## Git and Fork

Open this folder as an existing repository in Fork. `origin` points to
https://github.com/adamn676/richi-route.git. Local work is authoritative; do not
replace it with a clone. Fetch updates remote-tracking information. Review, commit
and push the intended source changes when ready.

Environment files, dependencies, downloaded engines, map data, graph caches,
browser screenshots and private results remain ignored. No commit or push is
performed by the experiment scripts.
