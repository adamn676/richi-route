# 🤖 AI Development Prompt: RichiRoute – Market-Leading Bicycle Route Planner 🚴

**Document Version:** 1.3
**Last Updated:** May 21, 2025
**AI Persona:** Senior Frontend Engineer & Vue.js/GIS Expert

**Core Objective:** Develop **RichiRoute**, a production-ready **Vue 3** bicycle route planner, with the ambition to become a market leader. Focus on intuitive UX/UI, advanced interactive route mapping, and maintainable, production-quality TypeScript code.

**Primary Technologies:** Vue 3 (Composition API), TypeScript, MapLibre GL, MapTiler (Tiles & Geocoding), OpenRouteService (Routing), Pinia (State), Tailwind CSS v4, Axios, PrimeVue v4 (Material Theme).

**Development Philosophy:** Prioritize robust **core interactive routing functionality first**. Incrementally enhance UI/UX and introduce advanced features based on the defined priorities and strategies. Ensure all code is fully typed, modular, and well-documented.

---

## 📜 Table of Contents

1.  [Project Vision & Ambition](#-project-vision--ambition)
2.  [Core Application State (Current)](#-core-application-state-current)
3.  [Next Development Iteration: Key Tasks](#-next-development-iteration-key-tasks)
4.  [Detailed Feature Specifications & UX Flows](#-detailed-feature-specifications--ux-flows)
    - [Map Interaction & Waypoint Management](#map-interaction--waypoint-management)
    - [Route Shaping (Soft Points)](#route-shaping-soft-points)
    - [Routing Logic & Optimization Strategy](#routing-logic--optimization-strategy)
5.  [Technical Stack & Versions](#-technical-stack--versions)
6.  [Map Services & API Integration Details](#-map-services--api-integration-details)
7.  [Coding Standards & Project Structure](#-coding-standards--project-structure)
8.  [Future & Optional Enhancements](#-future--optional-enhancements)
9.  [Non-Functional Requirements](#-non-functional-requirements)
10. [Project File Structure Reference](#-project-file-structure-reference)

---

## 🥇 Project Vision & Ambition

Our goal with **RichiRoute** is to become the **market-leading bicycle route planner**. We aim to provide cycling enthusiasts with an intuitive, innovative, and reliable tool, setting new standards for UX/UI quality, unique map interactions, and cyclist-specific features. Every design and development decision must align with this ambition.

---

## 📍 Core Application State (Current)

This section summarizes the implemented functionality _before_ the next set of tasks. Assume the following components and logic are in place and functional as described:

1.  **Core Routing Store (`route.store.ts`):**

    - Manages waypoints (`id: string`, `coords`, `address`, `kind`, `userInput`, `isGeocoding`) and shaping points (`id: string`, `idx: number`, `coord: Coord`). The `ShapePoint.idx` is `original_segment_idx + 1` and is used to associate shaping points with segments between hard waypoints.
    - `waypoints`: Initialized with two default waypoints (Start, End) at `[0,0]`, each having a unique ID.
    - `addWaypointByClick(coord)`:
      - If Start is `[0,0]`, updates Start.
      - Else if End is `[0,0]`, updates End.
      - Else, adds a new "via" waypoint before End.
      - Triggers `geocodeWaypoint()` for the affected waypoint. (Explicit `recalc()` removed, handled by watcher).
    - `insertWaypointOnRoute(indexAfter: number, coord: Coord)`: Inserts a new "via" waypoint, triggers `geocodeWaypoint()`. (Explicit `recalc()` removed).
    - `updateWaypointCoord(waypointId: string, newCoords: Coord)`: Updates coordinates for an existing waypoint, **clears all `shapingPoints`**, triggers `geocodeWaypoint()`. (Explicit `recalc()` removed).
    - `geocodeWaypoint(waypointId: string)`: Reverse geocodes coordinates to update `address` and `userInput` for the given waypoint.
    - `searchAndSetWaypointAddress(waypointId: string, query: string)`: Forward geocodes a query, updates waypoint coords, address, `userInput`, and kind. (Explicit `recalc()` removed).
    - `insertShapingPoint(originalSegmentIdxPlusOne: number, coord: Coord)`: Adds a new shaping point with a unique `id` and the provided `idx`. Uses `push` and then sorts `shapingPoints` by `idx`. (Explicit `recalc()` removed).
    - `updateShapingPointCoord(shapingPointId: string, newCoords: Coord)`: Updates the coordinates of an existing shaping point by its ID. (Explicit `recalc()` removed).
    - `recalc(options?: { forceGlobalOptimize?: boolean })`:
      - This is the central recalculation orchestrator, primarily triggered by a watcher in `useRouteCalculation.ts`.
      - If `forceGlobalOptimize`, clears `shapingPoints` first.
      - Calls `calculateHardRoute()`.
      - If shaping points exist and a route exists, calls `applyShaping()`.
    - `calculateHardRoute()`: Calculates route using only `waypoints` with valid coordinates.
    - `applyShaping()`:
      - **If 2 waypoints & shaping points exist:** ORS call: `[start_coord, ...sorted_shaping_coords, end_coord]`.
      - **If >2 waypoints & shaping points exist (REFINED):** Constructs a single coordinate list for ORS: `[wp1_coords, ...shaping_points_between_wp1_wp2, wp2_coords, ...shaping_points_between_wp2_wp3, wp3_coords, ...]`. This respects all intermediate hard waypoints.
    - `optimizeEntireRoute()`: Calls `recalc({ forceGlobalOptimize: true })`.
    - ORS API calls are throttled and cached via `route.service.ts`. The cache key is based on coordinates.
    - `maptiler.service.ts` handles geocoding.
    - Most explicit `recalc()` calls within actions have been removed to rely on the central watcher in `useRouteCalculation.ts`.

2.  **MapView & Core Composables:**

    - `MapView.vue`: Container for the map; initializes map via `useMap.ts`.
    - `useMapInteractions.ts`: Handles map clicks.
      - If click is on a route segment (within `DIST_ROUTE`): calls `routeStore.insertWaypointOnRoute()`.
      - Else: calls `routeStore.addWaypointByClick()`.
    - `useRouteDragging.ts`: Handles dragging on route segments (`SEGMENTS_BASE_LAYER`) to create new shaping points.
      - `mousedown`: Captures segment `idx` (0-based `feature.properties.idx`).
      - `mousemove`: Updates a temporary marker (e.g., `'temp-shaping'` type from `CustomMarker.vue`). No client-side curve preview is rendered during drag.
      - `mouseup`: Calls `routeStore.insertShapingPoint(segment_idx + 1, new_coords)`.
    - `useMarkerWatches.ts`: Watches `routeStore.waypoints` and `routeStore.shapingPoints`.
      - Calls `createWaypointMarkers` from `useMapMarkers.ts` to sync waypoint markers (draggable, `dragend` calls `routeStore.updateWaypointCoord()`).
      - Calls `createShapingMarkers` from `useMapMarkers.ts` to sync shaping point markers. These are persistent, draggable, and styled subtly. Their `dragend` calls `routeStore.updateShapingPointCoord()`.
    - `useMapMarkers.ts`:
      - Creates/manages MapLibre GL markers using `CustomMarker.vue`.
      - `createWaypointMarkers`: Creates/updates draggable waypoint markers.
      - `createShapingMarkers`: Creates/updates persistent, draggable shaping point markers with a distinct, subtle style. Handles their `dragend` to update coordinates in the store.
      - `createCustomMarkerElement`: Enhanced to provide distinct styles for `'waypoint'`, `'shaping'` (persistent dot), and `'temp-shaping'` (temporary drag indicator) marker types.
      - `createTempMarker`: Used by `useRouteDragging.ts` for temporary visual feedback.
    - `useRouteCalculation.ts`: Watches `routeStore.waypoints` (stringified) and `routeStore.shapingPoints` (stringified). This is now the primary trigger for `routeStore.recalc()`. Redundant `recalc()` calls in store actions have been mostly removed.
    - `SegmentedRouteLayer.vue` (or `useSegmentedRoute.ts`): Renders the route from `routeStore.route` as distinct segments, handles hover highlighting, displays arrows. Reacts to `routeStore.route` changes to update the displayed route.

3.  **UI Components:**

    - `WaypointsPanel.vue`:
      - Displays waypoints from `routeStore.waypoints`.
      - Each waypoint has an `AddressSearchInput.vue` bound to `waypoint.userInput`.
      - Allows reordering waypoints (updates store and triggers `recalc`).
      - Allows removing waypoints (calls `routeStore.removeWaypoint()`).
      - "Add Waypoint" button calls `routeStore.addIntermediateStopAndPrepare()`.
      - (Note: Does _not_ display "shaping points").
    - `CustomMarker.vue`: Vue component for waypoint and shaping point visuals. Prop validation for `type` now includes `'temp-shaping'`. Styled to differentiate waypoints, persistent shaping points (small dots), and temporary shaping drag indicators.
    - `AddressSearchInput.vue`: Provides address suggestions via `forwardGeocode`; on selection, updates the corresponding waypoint in the store.

4.  **Stores:**

    - `map.store.ts`: Basic map configuration (API key, center, zoom), holds map instance.
    - `user.store.ts`: IP/browser geolocation for initial map centering.

5.  **Notifications (`useNotification.ts`):** Basic toast notifications for errors/info.

---

## 🚀 Next Development Iteration: Key Tasks

The following tasks from the previous iteration have been addressed:

- **Task 1: Refine `route.store.ts :: applyShaping()` for Multi-Stop Routes: COMPLETED.** The logic now correctly respects all intermediate hard waypoints when shaping points are present.
- **Task 2: Implement Client-Side Drag Preview (Catmull-Rom/Bezier): MODIFIED.** User opted against a client-side curve preview. `useRouteDragging.ts` shows a temporary marker during drag and commits the point on mouseup.
- **Task 3: Persistent & Draggable Shaping Point Markers: COMPLETED.** Shaping points are now represented by persistent, draggable markers on the map, and dragging them updates the route.
- **Design Sophisticated Shaping Point Radius Strategy: COMPLETED.** Decided on an automatic, primarily zoom-level dependent radius for shaping points, and a small fixed default radius for hard waypoints. This strategy leverages the OpenRouteService `radiuses` parameter. The user will not manage radiuses directly, ensuring UI simplicity.

The **upcoming key tasks** are (re-prioritized if needed):

1.  **Implement Automatic Radius Strategy for Waypoints & Shaping Points:**
    - **Task:** Implement the designed automatic radius strategy.
    - **Store (`route.store.ts`):**
        - Modify `ShapePoint` interface to include `radius: number`.
        - Update `Waypoint` interface if a default radius needs to be associated there too (or handle it in `route.service.ts`).
        - Update actions `insertShapingPoint` and `updateShapingPointCoord` to accept, calculate (if not provided by caller), and store this `radius`.
    - **Composables (`useRouteDragging.ts`, `useMapMarkers.ts`):**
        - Implement logic to calculate radius based on map zoom level during `mouseup` (for new shaping points) and `dragend` (for existing shaping points) events. Pass this radius to the relevant store actions.
    - **Service (`route.service.ts`):**
        - Modify `getRoute` to construct the `radiuses: number[]` array for the ORS API call. Assign small fixed radiuses for hard waypoints and use the stored/calculated dynamic radiuses for shaping points.
        - Update the ORS request cache key to include the `radiuses` array to ensure correct caching.
    - **Testing:** Thoroughly test the radius calculation at different zoom levels and in various geographic contexts.

2.  **"Optimize Entire Route" Button & UX (Task 4 from previous list, now Task 2):**

    - **Task:** Add a clearly visible button (e.g., in `MapControls.vue` or `WaypointsPanel.vue`) labeled "Optimize Entire Route."
    - **Action:** Clicking this button should call `routeStore.optimizeEntireRoute()`, which clears all `shapingPoints` and recalculates the route using only the hard `waypoints`.
    - **Feedback:** Provide clear visual feedback (e.g., spinner, toast notification) during this global optimization.

3.  **Modifier Key for Local Splicing Override (Conceptual - Design Only for Now) (Task 5 from previous list, now Task 3):**

    - **Task (Design):** Think about how an `Alt/Option` key press during a drag or click could temporarily alter the default routing behavior (e.g., force a global splice if the default was local, or vice-versa).
    - **Deliverable:** A brief description of the proposed UX and how it might integrate. No implementation code for this iteration unless trivial.

4.  **Surface-Type Visualization (Basic) (Task 6 from previous list, now Task 4):**
    - **Task:** After a route is calculated and `routeStore.route` is populated, parse the ORS response to differentiate segments by surface type (e.g., "paved" vs. "unpaved/loose").
    - **Implementation:** Modify `SegmentedRouteLayer.vue` (or `useSegmentedRoute.ts`) to apply different styling (e.g., distinct colors or line patterns like dashes for unpaved) to route segments based on this data.
    - **Data Source:** Investigate the ORS GeoJSON response (`features[0].properties.segments[i].steps[j].surface` or similar, or `extras` if requested). Update `orsToFeatureCollection` (in `route.store.ts`) and `getSegments` (in `utils/geometry.ts`) if necessary to preserve and map this data appropriately for rendering.

---

## 📖 Detailed Feature Specifications & UX Flows

### Map Interaction & Waypoint Management

- **A. Setting Start/End Points (Implemented):**

  1.  **First Map Click:** Sets the **Start** waypoint. Coordinates are updated in `routeStore.waypoints[0]`. `geocodeWaypoint()` is called for this waypoint, and its `address` and `userInput` are updated. The `WaypointsPanel.vue` reflects this.
  2.  **Second Map Click:** Sets the **End** waypoint. Coordinates are updated in `routeStore.waypoints[1]`. `geocodeWaypoint()` is called, and `WaypointsPanel.vue` reflects this.

  - A route is calculated and displayed after the End point is set (if Start is also valid).

- **B. Adding Intermediate "Via" Waypoints by Map Click on Route (Implemented):**

  1.  User clicks directly on an existing route segment on the map.
  2.  `useMapInteractions.ts` detects this (within `DIST_ROUTE` tolerance).
  3.  A new "via" waypoint is inserted into `routeStore.waypoints` at the correct position (determined by the clicked segment's `idx` via `routeStore.insertWaypointOnRoute()`).
  4.  This new waypoint is geocoded, and its address and `userInput` are populated.
  5.  It appears in the `WaypointsPanel.vue` like any other hard waypoint and is reorderable/removable.
  6.  The route recalculates respecting this new hard via point.

- **C. Adding Intermediate "Via" Waypoints by Map Click (Not on Route) (Implemented):**

  1.  After Start and End are set, a map click _not_ on the route adds a new "via" waypoint before the current End point (`routeStore.addWaypointByClick()`).
  2.  This new waypoint is geocoded and appears in `WaypointsPanel.vue`.

- **D. Waypoint Management in `WaypointsPanel.vue` (Implemented):**

  1.  **Address Search:** Typing in an `AddressSearchInput` for a waypoint triggers `routeStore.searchAndSetWaypointAddress()`, updating its coords, address, kind, and `userInput`. Route recalculates.
  2.  **Reordering:** Drag-and-drop reordering of waypoints in the panel updates their order in `routeStore.waypoints` and triggers a global route recalculation.
  3.  **Removal:** Removing a waypoint from the panel calls `routeStore.removeWaypoint()`, triggers `recalc()`. If Start/End are removed, they reset to `[0,0]` and default labels.
  4.  **Adding "Via":** "Add Waypoint" button adds a new, un-geocoded "via" point to the panel and store.

- **E. Waypoint Marker Dragging (Implemented):**
  1.  Waypoint markers on the map are draggable.
  2.  On `dragend`, `routeStore.updateWaypointCoord()` is called with the marker's associated waypoint ID and new coordinates. This clears all `shapingPoints` and triggers a full `recalc()` and `geocodeWaypoint()` for the moved waypoint.

### Route Shaping (Soft Points)

_(This section describes the target state, including the planned radius implementation)_

- **A. Creating Shaping Points by Dragging Route Segment (Partially Implemented; Radius aspect is Next Task):**

  1.  User hovers over a route segment. A small, draggable "shaping handle" (e.g., a circle, the `'temp-shaping'` marker) appears on the route line directly under the mouse cursor (or is created on mousedown by `useRouteDragging.ts`).
  2.  User mousedowns on this shaping handle/segment to initiate the drag. `useRouteDragging.ts` initiates drag.
  3.  `mousemove`: The temporary shaping marker follows the cursor. No client-side curve (Catmull-Rom/Bezier) preview is shown.
  4.  `mouseup`: `routeStore.insertShapingPoint(original_segment_idx + 1, dropped_coords, calculated_radius)` will be called. The `idx` helps order shaping points. The `calculated_radius` (based on zoom) will be a new parameter. Route recalculates via `applyShaping()`.
  5.  A persistent, small, draggable marker (the `'shaping'` type) is created for this shaping point on the map (handled by `useMarkerWatches` and `useMapMarkers`).

- **B. Dragging Persistent Shaping Point Markers (Partially Implemented; Radius aspect is Next Task):**

  1.  User `mousedown`s on a persistent shaping point marker.
  2.  `mousemove`: Marker follows cursor. (No live client-side curve preview for the route itself).
  3.  `mouseup`: `routeStore.updateShapingPointCoord(shapingPointId, new_coords, recalculated_radius)` will be called. The `recalculated_radius` (based on zoom) will be a new parameter. Route recalculates via `applyShaping()`.

- **C. Nature of Shaping Points (Target State):**
  - Shaping points are _not_ displayed in `WaypointsPanel.vue`.
  - They do not have addresses or `userInput` fields.
  - They purely influence the geometry of the route between hard waypoints.
  - User should never see an explicit "Hard vs. Soft point" prompt.
  - Shaping points will be assigned an automatically determined, context-aware radius (primarily based on map zoom level at the time of creation/modification). This radius will be used by ORS to allow for softer, more natural pathfinding by providing flexibility in how strictly the route adheres to the exact shaping point coordinate. This radius management is internal and not directly exposed to the user.

### Routing Logic & Optimization Strategy

_(This section describes the target strategy, including the planned radius implementation)_

1.  **Default Behavior - Local Splicing Focus (Target for Shaping - Implemented for >2 Waypoints):**

    - When a user adds/moves a **shaping point**:
      - **If 2 hard waypoints:** The route is recalculated globally between them including all shaping points: `[W1, ...all_SPs, W2]`.
      - **If >2 hard waypoints:** The route is recalculated globally respecting all intermediate hard waypoints and slotting shaping points between them: `[W1, ...SPs_between_W1_W2, W2, ...SPs_between_W2_W3, W3, ...]`. This refinement (original Task 1) is **completed**.

2.  **One-Click "Optimize Entire Route" (To Be Implemented - Task 2 as per new numbering):**

    - A dedicated UI button.
    - Action: Clears _all_ `shapingPoints` from the store.
    - Calls `routeStore.calculateHardRoute()` using only the existing `waypoints`.
    - This provides a "reset" for the shaping and gives the globally optimal path for the hard waypoints.

3.  **Live Client-Side Drag Feedback (Modified - No Curve Preview):**

    - During `mousedown` + `mousemove` for route shaping (creating a new shaping point), a temporary marker follows the cursor. No client-side Catmull-Rom or Bezier spline preview of the route itself is displayed during the drag.
    - On `mouseup`, the shaping point is committed, and ORS is called for the route update.

4.  **Interaction Model - No "Hard or Soft" Prompts (Implemented as described):**

    - Waypoints created/managed via `WaypointsPanel.vue` or by clicking the map are "hard waypoints."
    - Points created by dragging a route segment become "shaping points."

5.  **Modifier Key for Quick Overrides (Conceptual - To Be Designed - Task 3 as per new numbering):**

    - Holding `Alt/Option` during a map interaction could temporarily toggle recalculation behavior.

6.  **"Two-Phase Splicing" for Routes with ≥3 Hard Waypoints (Implemented via refined `applyShaping`):**

    - **Phase 1 (In `calculateHardRoute`):** Calculate "backbone" `W1 -> W2 -> ... -> Wn`.
    - **Phase 2 (In `applyShaping`):** When shaping points exist, they are applied _between_ their respective hard waypoints using the refined single ORS call logic. This is **completed**.

7.  **Surface & Elevation Overlays (To Be Implemented - Task 4 as per new numbering for Surface):**

    - After each route calculation, parse ORS "surface" or "waytype" data.
    - Color-code rendered route segments.

8.  **Visual Feedback & Controls (Ongoing / Implemented for Markers):**
    - Clear visual distinction between waypoint markers, persistent shaping point markers (small dots), and temporary drag indicators.
    - Spinners/shimmer effects during API calls (partially via `isCalculatingGlobalRoute`, can be enhanced).

9.  **Utilizing ORS `radiuses` Parameter (Target State for Next Task):** The system will leverage the `radiuses` parameter in OpenRouteService API calls. Hard waypoints will be given a small, fixed radius to ensure precision while allowing for minor network snapping. Shaping points will be given dynamic, context-dependent radiuses (primarily based on map zoom level) to allow for more flexible and natural route shaping without requiring user management of this technical detail.

---

## 🛠️ Technical Stack & Versions

- **Framework:** Vue 3.5.13 + TypeScript (Composition API, `<script setup>`)
- **State Management:** Pinia 3.0.2
- **Map Rendering:** MapLibre GL 5.3.0
- **Map Tiles & Geocoding:** MapTiler (via API)
- **Geospatial Analysis:** Turf.js 7.2.0
- **Routing Engine:** OpenRouteService (via API)
- **HTTP Client:** Axios 1.8.4 (with `axios-retry`)
- **UI Framework:** PrimeVue 4.3.3 (Material theme) + PrimeIcons 7.0.0
- **CSS Framework:** Tailwind CSS 4.1.3
- **Drag & Drop (UI Panels):** vue-draggable-plus 0.6.0
- **Build Tool:** Vite 6.2.0
- **Testing (Planned):** Vitest, Vue Test Utils, (Consider Playwright for E2E)

---

## 🗺️ Map Services & API Integration Details

### MapTiler

- **Role:** Base map tiles, forward/reverse geocoding.
- **Integration:** MapLibre GL for tiles; Axios for geocoding API calls.
- **Key:** `VITE_MAPTILER_API_KEY` in `.env`.

### MapLibre GL

- **Role:** Map rendering, marker management, layer styling, on-map interaction events.

### OpenRouteService

- **Role:** Bicycle route calculation.
- **Endpoint:** `/v2/directions/cycling-regular/geojson`.
- **Key:** `VITE_ORS_API_KEY` in `.env`.
- **Features to Utilize:** Coordinates, geometry, `radiuses` (for nuanced control over waypoint and shaping point snapping/flexibility - *to be implemented*), (later: surface types from `extras`, elevation).
- **Note:** API calls are throttled and responses cached by `route.service.ts`.

---

## 🧑‍💻 Coding Standards & Project Structure

- **TypeScript:** Strict typing, no implicit `any`. `tsconfig.json` settings should be reasonably strict.
- **Vue:** Composition API exclusively. `<script setup>` syntax.
- **Modularity:**
  - `components/`: Reusable UI components.
  - `composables/`: Reusable Composition API functions.
  - `stores/`: Pinia stores.
  - `services/`: API interaction logic.
  - `views/`: Top-level page components.
  - `router/`: Vue Router configuration.
  - `config/`: Application-wide configurations.
  - `types/`: Shared TypeScript type definitions.
  - `utils/`: General utility functions.
- **Documentation:** JSDoc comments.
- **Maintainability:** Clear, readable, refactorable code.
- **Linting/Formatting:** ESLint + Prettier.

---

## 🔮 Future & Optional Enhancements (Post-Core Iteration)

- Advanced surface-type visualization.
- Elevation profile chart.
- Custom bicycle profiles.
- Saving/Loading routes.
- Undo/Redo.
- Offline capabilities.
- User accounts.
- GPX Import/Export.
- Mobile & Responsive Layout improvements.
- Testing.
- Performance Tuning.
- Internationalization.

---

## 📋 Non-Functional Requirements

- **Performance:** LCP < 3s, Route Calc < 2-3s, Map Interactions < 100ms.
- **Accessibility:** WCAG 2.1 AA.
- **Security:** Protect API keys.
- **Error Handling:** Graceful degradation, informative messages, retry mechanisms.

---

## 🗃️ Project File Structure Reference

<details>
<summary>Click to expand full project file structure</summary>
<pre>
richi-route/
  ├── .github/
  │   └── workflows/
  │       └── ci.yml
  ├── public/
  │   ├── favicon.ico
  │   └── robots.txt
  ├── src/
  │   ├── assets/
  │   │   └── images/
  │   ├── components/
  │   │   ├── common/
  │   │   │   ├── AddressSearchInput.vue
  │   │   │   ├── BaseButton.vue
  │   │   │   └── ...
  │   │   ├── layout/
  │   │   │   ├── AppHeader.vue
  │   │   │   ├── AppFooter.vue
  │   │   │   └── AppSidebar.vue
  │   │   ├── map/
  │   │   │   ├── CustomMarker.vue
  │   │   │   ├── MapControls.vue
  │   │   │   ├── MapView.vue
  │   │   │   └── (Potentially ElevationProfile.vue here later)
  │   │   ├── ui/
  │   │   │   ├── Icon.vue
  │   │   │   └── WaypointsPanel.vue
  │   ├── composables/
  │   │   ├── useMap.ts
  │   │   ├── useMapInteractions.ts
  │   │   ├── useMapMarkers.ts
  │   │   ├── useMarkerWatches.ts
  │   │   ├── useNotification.ts
  │   │   ├── useRouteCalculation.ts
  │   │   ├── useRouteDragging.ts
  │   │   └── useSegmentedRoute.ts
  │   ├── config/
  │   │   ├── index.ts
  │   │   ├── map.config.ts
  │   │   └── mapStyle.ts
  │   ├── icons/
  │   │   └── materialIcons.ts
  │   ├── router/
  │   │   └── index.ts
  │   ├── services/
  │   │   ├── api.service.ts
  │   │   ├── geolocation.service.ts
  │   │   ├── index.ts
  │   │   ├── maptiler.service.ts
  │   │   ├── route.service.ts
  │   │   └── storage.service.ts
  │   ├── stores/
  │   │   ├── index.ts
  │   │   ├── map.store.ts
  │   │   ├── route.store.ts
  │   │   └── user.store.ts
  │   ├── styles/
  │   │   └── main.css
  │   ├── types/
  │   │   └── index.ts
  │   ├── utils/
  │   │   ├── geometry.ts
  │   │   ├── helpers.ts
  │   │   └── placeIcons.ts
  │   ├── views/
  │   │   └── HomeView.vue
  │   ├── App.vue
  │   ├── main.ts
  │   └── vite-env.d.ts
  ├── .env
  ├── .env.development
  ├── .env.production
  ├── .gitignore
  ├── index.html
  ├── package.json
  ├── README.md
  ├── tsconfig.json
  ├── vite.config.ts
  └── yarn.lock (or package-lock.json)
</pre>
</details>

---

This prompt should provide a clear, detailed, and actionable guide for AI-assisted development of the RichiRoute application. Remember to update the "Core Application State (Current)" section after each major development iteration to accurately reflect the new baseline for subsequent tasks.