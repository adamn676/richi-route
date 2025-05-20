# 🤖 AI Development Prompt: RichiRoute – Market-Leading Bicycle Route Planner 🚴

**Document Version:** 1.1
**Last Updated:** May 18, 2025 (Please use current date for responses)
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

    - Manages waypoints (id, coords, address, kind, userInput, isGeocoding) and shaping points (idx, coord).
    - `waypoints`: Initialized with two default waypoints (Start, End) at `[0,0]`.
    - `addWaypointByClick(coord)`:
      - If Start is `[0,0]`, updates Start.
      - Else if End is `[0,0]`, updates End.
      - Else, adds a new "via" waypoint before End.
      - Triggers `recalc()` and `geocodeWaypoint()`.
    - `insertWaypointOnRoute(indexAfter: number, coord: Coord)`: Inserts a new "via" waypoint at the specified index (derived from clicked route segment), triggers `recalc()` and `geocodeWaypoint()`.
    - `updateWaypointCoord(waypointId: string, newCoords: Coord)`: Updates coordinates for an existing waypoint, clears shaping points, triggers `recalc()` and `geocodeWaypoint()`.
    - `geocodeWaypoint(waypointId: string)`: Reverse geocodes coordinates to update address and `userInput` field for the given waypoint.
    - `searchAndSetWaypointAddress(waypointId: string, query: string)`: Forward geocodes a query, updates waypoint coords, address, `userInput`, and kind; triggers `recalc()`.
    - `insertShapingPoint(idx: number, coord: Coord)`: Adds a shaping point (`{idx, coord}` where `idx` is the _original clicked segment index + 1_) and sorts `shapingPoints` by `idx`. Triggers `recalc()`.
    - `recalc(options?: { forceGlobalOptimize?: boolean })`:
      - Calls `calculateHardRoute()`.
      - If shaping points exist and a route exists, calls `applyShaping()`.
      - If `forceGlobalOptimize`, clears shaping points first.
    - `calculateHardRoute()`: Calculates route using only `waypoints` with valid coordinates.
    - `applyShaping()`:
      - **If 2 waypoints & shaping points exist:** ORS call: `[start_coord, ...sorted_shaping_coords, end_coord]`.
      - **If >2 waypoints & shaping points exist (Current Impl.):** ORS call: `[first_valid_waypoint_coord, ...sorted_shaping_coords, last_valid_waypoint_coord]`. (Note: This currently bypasses intermediate hard waypoints when shaping).
    - `optimizeEntireRoute()`: Triggers `recalc({ forceGlobalOptimize: true })`.
    - ORS API calls are throttled and cached via `route.service.ts`.
    - `maptiler.service.ts` handles geocoding.

2.  **MapView & Core Composables:**

    - `MapView.vue`: Container for the map; initializes map via `useMap.ts`.
    - `useMapInteractions.ts`: Handles map clicks.
      - If click is on a route segment (within `DIST_ROUTE`): calls `routeStore.insertWaypointOnRoute()`.
      - Else: calls `routeStore.addWaypointByClick()`.
    - `useRouteDragging.ts`: Handles dragging on route segments (`SEGMENTS_BASE_LAYER`).
      - `mousedown`: Captures segment `idx`.
      - `mousemove`: Updates a temporary marker.
      - `mouseup`: Calls `routeStore.insertShapingPoint(segment_idx + 1, new_coords)`.
      - (Note: No client-side Catmull-Rom spline preview is implemented _during_ the drag yet, only a temporary marker moving).
    - `useMarkerWatches.ts`: Watches `routeStore.waypoints` and `routeStore.shapingPoints`. Calls `createWaypointMarkers` and `createShapingMarkers` from `useMapMarkers.ts` to keep map markers synced with store data (including on `dragend` for waypoints).
    - `useMapMarkers.ts`: Creates/manages MapLibre GL markers using `CustomMarker.vue`. Waypoint markers have `dragend` listeners calling `routeStore.updateWaypointCoord()`. Shaping point markers are created but are not currently draggable post-creation.
    - `useRouteCalculation.ts`: Watches `routeStore.waypoints` and `shapingPoints` (stringified coords) and triggers `routeStore.recalc()`.
    - `SegmentedRouteLayer.vue` (or similar component/composable like `useSegmentedRoute.ts`): Renders the route from `routeStore.route` as distinct segments, handles hover highlighting of segments, and displays arrows.

3.  **UI Components:**

    - `WaypointsPanel.vue`:
      - Displays waypoints from `routeStore.waypoints`.
      - Each waypoint has an `AddressSearchInput.vue` bound to `waypoint.userInput`.
      - Allows reordering waypoints (updates store and triggers `recalc`).
      - Allows removing waypoints (calls `routeStore.removeWaypoint()`).
      - "Add Waypoint" button calls `routeStore.addIntermediateStopAndPrepare()`.
      - (Note: Does _not_ display "shaping points").
    - `CustomMarker.vue`: Vue component for waypoint and shaping point visual representation on the map.
    - `AddressSearchInput.vue`: Provides address suggestions via `forwardGeocode`; on selection, updates the corresponding waypoint in the store.

4.  **Stores:**

    - `map.store.ts`: Basic map configuration (API key, center, zoom), holds map instance.
    - `user.store.ts`: IP/browser geolocation for initial map centering.

5.  **Notifications (`useNotification.ts`):** Basic toast notifications for errors/info.

---

## 🚀 Next Development Iteration: Key Tasks

Based on the "Routing Logic & Optimization Strategy" and "Map Interaction & Waypoint Management" specifications below, implement and/or refine the following in order of priority:

1.  **Refine `route.store.ts :: applyShaping()` for Multi-Stop Routes:**

    - **Task:** Modify the `applyShaping()` method (or the logic that prepares coordinates for ORS in `recalc`) when there are more than two hard waypoints (`this.waypoints.length > 2`) and shaping points exist.
    - **Required Behavior:** The route calculation must respect _all_ intermediate hard waypoints in their correct order, with shaping points slotted between the relevant hard waypoints.
    - **Example Coordinate List for ORS:** `[wp1_coords, ...shaping_points_between_wp1_wp2, wp2_coords, ...shaping_points_between_wp2_wp3, wp3_coords, ...]`.
    - **Guidance:** The `idx` property on `ShapePoint` (currently `original_segment_idx + 1`) will need to be used to correctly associate shaping points with the segments between hard waypoints. You may need to map these global segment indices to inter-waypoint segments.

2.  **Implement Client-Side Drag Preview (Catmull-Rom/Bezier):**

    - **Task:** Enhance `useRouteDragging.ts`. When a user drags a route segment (`mousedown` + `mousemove`):
      - Instead of just moving a simple temporary marker, render a client-side smoothed curve (e.g., Catmull-Rom or Bezier spline) from the start of the dragged segment, through the current mouse position (acting as the shaping point), to the end of the dragged segment. This provides instant visual "rubber-band" feedback.
      - This preview should _not_ make ORS API calls.
    - **On `mouseup`:** The existing logic to call `routeStore.insertShapingPoint()` remains, which then triggers the actual ORS recalculation.

3.  **Persistent & Draggable Shaping Point Markers:**

    - **Task:** After a shaping point is created (on `mouseup` in `useRouteDragging.ts` and added to `routeStore.shapingPoints`), a persistent visual marker (e.g., a small, subtle dot) should be displayed on the map for _each_ shaping point.
    - These persistent shaping point markers must be draggable.
    - **`dragend` Behavior:** When a persistent shaping point marker is dragged and dropped, an action (e.g., `routeStore.updateShapingPointCoord(shapingPointIdOrIndex, newCoords)`) should be called to update its coordinates in the store and trigger a route recalculation using the updated shaping points. This implies shaping points might need unique IDs or their index used for updates.

4.  **"Optimize Entire Route" Button & UX:**

    - **Task:** Add a clearly visible button (e.g., in `MapControls.vue` or `WaypointsPanel.vue`) labeled "Optimize Entire Route."
    - **Action:** Clicking this button should call `routeStore.optimizeEntireRoute()`, which clears all `shapingPoints` and recalculates the route using only the hard `waypoints`.
    - **Feedback:** Provide clear visual feedback (e.g., spinner, toast notification) during this global optimization.

5.  **Modifier Key for Local Splicing Override (Conceptual - Design Only for Now):**

    - **Task (Design):** Think about how an `Alt/Option` key press during a drag or click could temporarily alter the default routing behavior (e.g., force a local splice if the default was global, or vice-versa).
    - **Deliverable:** A brief description of the proposed UX and how it might integrate. No implementation code for this iteration unless trivial.

6.  **Surface-Type Visualization (Basic):**
    - **Task:** After a route is calculated and `routeStore.route` is populated, parse the ORS response to differentiate segments by surface type (e.g., "paved" vs. "unpaved/loose").
    - **Implementation:** Modify `SegmentedRouteLayer.vue` (or `useSegmentedRoute.ts`) to apply different styling (e.g., distinct colors or line patterns like dashes for unpaved) to route segments based on this data.
    - **Data Source:** Investigate the ORS GeoJSON response (`features[0].properties.segments[i].steps[j].surface` or similar, or `extras` if requested). Update `orsToFeatureCollection` if necessary to preserve this data appropriately for rendering.

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

- **A. Creating Shaping Points by Dragging Route Segment (Partially Implemented - Needs Drag Preview & Persistent Markers):**

  1.  User hovers over a route segment. A small, draggable "shaping handle" (e.g., a circle) appears on the route line directly under the mouse cursor.
  2.  User mousedowns on this shaping handle to initiate the drag. `useRouteDragging.ts` initiates drag.
  3.  **[TO BE IMPLEMENTED - Task 2]** `mousemove`: A client-side smoothed curve (Catmull-Rom/Bezier) preview is shown from segment start, through mouse cursor, to segment end. No ORS calls during drag.
  4.  `mouseup`: `routeStore.insertShapingPoint(original_segment_idx + 1, dropped_coords)` is called. The `idx` helps order shaping points. Route recalculates via `applyShaping()`.
  5.  **[TO BE IMPLEMENTED - Task 3]** A persistent, small, draggable marker is created for this shaping point on the map.

- **B. Dragging Persistent Shaping Point Markers (To Be Implemented - Task 3):**

  1.  User `mousedown`s on a persistent shaping point marker.
  2.  `mousemove`: Marker follows cursor. A live client-side curve preview (similar to A.3) could be shown for the affected segment(s).
  3.  `mouseup`: `routeStore.updateShapingPointCoord(shapingPointIdOrIndex, new_coords)` is called. Route recalculates via `applyShaping()`.

- **C. Nature of Shaping Points:**
  - Shaping points are _not_ displayed in `WaypointsPanel.vue`.
  - They do not have addresses or `userInput` fields.
  - They purely influence the geometry of the route between hard waypoints.
  - User should never see an explicit "Hard vs. Soft point" prompt.

### Routing Logic & Optimization Strategy

This is the **target strategy** to achieve. Parts marked "(Current Impl.)" in the "Core Application State" section need to be evolved to meet this.

1.  **Default Behavior - Local Splicing Focus (Target for Shaping):**

    - When a user adds/moves a **shaping point**, the system should ideally recalculate and splice only the affected local segment(s) between the nearest hard waypoints.
    - **Refinement Needed (Task 1):** The current `applyShaping()` for >2 waypoints does a global recalc using only first/last hard points + all shaping points. This needs to be refined to respect _all_ intermediate hard waypoints, effectively creating localized shaping between them.

2.  **One-Click "Optimize Entire Route" (Target - Task 4):**

    - A dedicated UI button.
    - Action: Clears _all_ `shapingPoints` from the store.
    - Calls `routeStore.calculateHardRoute()` using only the existing `waypoints`.
    - This provides a "reset" for the shaping and gives the globally optimal path for the hard waypoints.

3.  **Live Client-Side Drag Feedback (Target - Task 2):**

    - During `mousedown` + `mousemove` for route shaping, display a Catmull-Rom or Bezier spline for instant visual feedback. No ORS API calls during the drag itself for this preview.
    - On `mouseup`, the shaping point is committed, and ORS is called.

4.  **Interaction Model - No "Hard or Soft" Prompts:**

    - Waypoints created/managed via `WaypointsPanel.vue` (typed addresses, "Add Waypoint" button) or by clicking the map (to set Start/End/Via) are "hard waypoints" visible in the panel.
    - Points created by dragging a route segment become "shaping points" (not in panel, no address).

5.  **Modifier Key for Quick Overrides (Conceptual - Task 5 Design):**

    - Holding `Alt/Option` during a map interaction (e.g., drag release, click) could temporarily toggle the recalculation behavior (e.g., force a global route optimization even if a local shaping action was performed, or vice-versa).
    - This is for power users and requires clear but subtle UI feedback if implemented.

6.  **"Two-Phase Splicing" for Routes with ≥3 Hard Waypoints (Target for Task 1 Refinement):**

    - **Phase 1 (Already in `calculateHardRoute`):** Calculate the "backbone" route using all hard waypoints: `W1 -> W2 -> W3 -> ... -> Wn`.
    - **Phase 2 (Target for `applyShaping` Refinement):** When shaping points exist, they are applied _between_ their respective hard waypoints. The list of coordinates sent to ORS for a route with shaping points should be a single ordered list: `[W1, ...SPs_between_W1_W2, W2, ...SPs_between_W2_W3, W3, ...]`. This ensures shaping is localized and respects all hard via points.

7.  **Surface & Elevation Overlays (Target - Task 6 for Surface):**

    - After each route calculation, parse ORS "surface" or "waytype" data.
    - Color-code rendered route segments on the map (e.g., solid line for paved, dashed for gravel/unpaved).
    - (Future) Optionally show an elevation profile chart.

8.  **Visual Feedback & Controls (Ongoing):**
    - Clear visual distinction between waypoint markers and shaping point markers.
    - Spinners/shimmer effects during API calls.

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
- **Features to Utilize:** Coordinates, geometry, (later: surface types from `extras`, elevation).
- **Note:** API calls are throttled and responses cached by `route.service.ts`.

---

## 🧑‍💻 Coding Standards & Project Structure

- **TypeScript:** Strict typing, no implicit `any`. `tsconfig.json` settings should be reasonably strict.
- **Vue:** Composition API exclusively. `<script setup>` syntax.
- **Modularity:**
  - `components/`: Reusable UI components (atomic design principles where practical).
  - `composables/`: Reusable Composition API functions for specific logic (e.g., `useMapInteractions`, `useRouteDragging`).
  - `stores/`: Pinia stores for global state.
  - `services/`: API interaction logic, external service wrappers.
  - `views/`: Top-level page components.
  - `router/`: Vue Router configuration.
  - `config/`: Application-wide configurations (map styles, constants).
  - `types/`: Shared TypeScript type definitions.
  - `utils/`: General utility functions.
- **Documentation:** JSDoc comments for functions, composables, store actions/getters. Clear explanations for complex logic.
- **Maintainability:** Prioritize clear, readable, and easily refactorable code.
- **Linting/Formatting:** ESLint + Prettier (configure pre-commit hooks via Husky + lint-staged).

---

## 🔮 Future & Optional Enhancements (Post-Core Iteration)

- Advanced surface-type visualization (more granular categories and styling).
- Elevation profile chart (`ElevationProfile.vue`).
- Custom bicycle profiles (road, offroad, city) for ORS requests.
- Saving/Loading routes (local storage, backend).
- Undo/Redo functionality for route modifications.
- Offline capabilities (Service Workers, PWA).
- User accounts & synchronization.
- Gamification, AI-powered route suggestions.
- Import/Export GPX files.
- Mobile & Responsive Layout improvements (collapsible panels, touch interactions).
- Comprehensive Testing (Unit, Integration, E2E).
- Performance Tuning & Analytics (Sentry, etc.).
- Internationalization (i18n).

---

## 📋 Non-Functional Requirements

- **Performance:**
  - Initial Load (LCP): < 3 seconds.
  - Route Calculation (ORS response + render): < 2-3 seconds for typical routes.
  - Map Interactions (drag preview, hover): < 100ms perceived latency.
- **Accessibility:** Aim for WCAG 2.1 AA compliance (semantic HTML, ARIA attributes, keyboard navigation, color contrast).
- **Security:** Protect API keys. If user data is handled, ensure GDPR compliance and secure storage/transmission.
- **Error Handling:** Graceful degradation. Informative user messages for API errors, network issues, etc. Retry mechanisms for transient API failures (already in `route.service.ts` with `axios-retry`).

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
  │   │   └── images/          # Static image assets
  │   ├── components/
  │   │   ├── common/          # Generic, reusable UI elements
  │   │   │   ├── AddressSearchInput.vue
  │   │   │   ├── BaseButton.vue
  │   │   │   └── ... (other base elements)
  │   │   ├── layout/          # Page structure components
  │   │   │   ├── AppHeader.vue
  │   │   │   ├── AppFooter.vue
  │   │   │   └── AppSidebar.vue # Main container for WaypointsPanel etc.
  │   │   ├── map/             # Map-specific components
  │   │   │   ├── CustomMarker.vue
  │   │   │   ├── MapControls.vue # Zoom, MyLocation, OptimizeRouteButton
  │   │   │   ├── MapView.vue     # Main map container component
  │   │   │   └── (Potentially ElevationProfile.vue here later)
  │   │   ├── ui/              # More specific UI feature components
  │   │   │   ├── Icon.vue
  │   │   │   └── WaypointsPanel.vue
  │   ├── composables/         # Vue Composition API functions
  │   │   ├── useMap.ts
  │   │   ├── useMapInteractions.ts
  │   │   ├── useMapMarkers.ts
  │   │   ├── useMarkerWatches.ts
  │   │   ├── useNotification.ts
  │   │   ├── useRouteCalculation.ts
  │   │   ├── useRouteDragging.ts
  │   │   └── useSegmentedRoute.ts  # (Or similar for managing route layers)
  │   ├── config/              # App configuration files
  │   │   ├── index.ts         # Main config export
  │   │   ├── map.config.ts    # Map-related constants (layer IDs, distances)
  │   │   └── mapStyle.ts      # Route line styling constants
  │   ├── icons/               # SVG icon definitions or mappings
  │   │   └── materialIcons.ts
  │   ├── router/              # Vue Router setup
  │   │   └── index.ts
  │   ├── services/            # External API/service integrations
  │   │   ├── api.service.ts   # Base Axios client
  │   │   ├── geolocation.service.ts
  │   │   ├── index.ts
  │   │   ├── maptiler.service.ts
  │   │   ├── route.service.ts # ORS integration
  │   │   └── storage.service.ts
  │   ├── stores/              # Pinia state management
  │   │   ├── index.ts
  │   │   ├── map.store.ts
  │   │   ├── route.store.ts
  │   │   └── user.store.ts
  │   ├── styles/              # Global styles
  │   │   └── main.css
  │   ├── types/               # TypeScript definitions
  │   │   └── index.ts
  │   ├── utils/               # Utility functions
  │   │   ├── geometry.ts
  │   │   ├── helpers.ts
  │   │   └── placeIcons.ts
  │   ├── views/               # Top-level route components
  │   │   └── HomeView.vue     # Primary view hosting MapView & WaypointsPanel
  │   ├── App.vue              # Root Vue component
  │   ├── main.ts              # Application entry point
  │   └── vite-env.d.ts
  ├── .env                     # For VITE_ORS_API_KEY, VITE_MAPTILER_API_KEY
  ├── .env.development
  ├── .env.production
  ├── .gitignore
  ├── index.html
  ├── package.json
  ├── README.md                # Standard project README (distinct from this AI prompt)
  ├── tsconfig.json
  ├── vite.config.ts
  └── yarn.lock (or package-lock.json)
</pre>
</details>

---

This prompt should provide a clear, detailed, and actionable guide for AI-assisted development of the RichiRoute application. Remember to update the "Core Application State (Current)" section after each major development iteration to accurately reflect the new baseline for subsequent tasks.
