import SwiftUI

/// The panel over the map, with the web planner's two tabs, the route and the rider's routes, and beside them the one
/// menu of what to do with the route, in view at every height of the panel.
struct RouteSheet: View {
    @Bindable var planner: Planner
    let folded: Bool
    /// The map's sources, as it shows them.
    let credits: String
    let fold: () -> Void
    /// Lowers the panel to half the screen, so a stretch shows on the map above its profile.
    let halve: () -> Void
    @State private var tab = Tab.route
    @State private var naming = false
    @State private var newName = ""
    @State private var choosingFile = false

    enum Tab { case route, library }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Picker("Bereiche", selection: $tab) {
                    Text("Route").tag(Tab.route)
                    Text("Meine Routen").tag(Tab.library)
                }
                .pickerStyle(.segmented)
                menu
            }
            .padding(.leading, 16)
            .padding(.trailing, 4)
            .padding(.top, 20)
            .padding(.bottom, 4)
            switch tab {
            case .route: RouteTab(planner: planner, folded: folded, credits: credits, fold: fold, halve: halve)
            // an opened route shows on the map above the half-lowered panel
            case .library: MyRoutes(planner: planner) {
                tab = .route
                halve()
            }
            }
        }
        .fileImporter(isPresented: $choosingFile, allowedContentTypes: [.gpx, .richiRoute, .json]) { chosen in
            guard case .success(let url) = chosen else { return }
            planner.open(fileAt: url)
            tab = .route
        }
        // the rider's routes are a list: the folded panel would cut its first row
        .onChange(of: tab) { if tab == .library && folded { halve() } }
        .alert("Route speichern", isPresented: $naming) {
            TextField("Routenname", text: $newName)
            Button("Abbrechen", role: .cancel) {}
            Button("Speichern") { if let name = RouteName.valid(newName) { planner.save(as: name) } }
                .disabled(RouteName.valid(newName) == nil)
                .keyboardShortcut(.defaultAction)
        }
    }

    private var menu: some View {
        Menu {
            Section {
                Button("Rückgängig", systemImage: "arrow.uturn.backward", action: planner.undo).disabled(!planner.canUndo)
                Button("Wiederholen", systemImage: "arrow.uturn.forward", action: planner.redo).disabled(!planner.canRedo)
                if !planner.routedLegs.isEmpty {
                    Button("Ganze Route zeigen", systemImage: "viewfinder") { planner.frame(whole: true) }
                }
            }
            Section {
                Button("Neue Route", systemImage: "plus") {
                    planner.newRoute()
                    tab = .route
                }
                Button("Datei öffnen …", systemImage: "folder") { choosingFile = true }
            }
            Section {
                if planner.savedID == nil {
                    Button("In „Meine Routen“ speichern …", systemImage: "bookmark") {
                        newName = planner.name
                        naming = true
                    }
                    .disabled(!planner.hasRoute)
                } else if !planner.isSaved {
                    Button("Änderungen speichern", systemImage: "bookmark", action: planner.saveChanges)
                }
                // as the planner's save menu: for a bike computer once every leg is routed, and to go on editing
                Menu {
                    let ready = planner.isComplete && !planner.isRouting
                    share(.gpx, "GPX", "Für den Radcomputer", ready: ready)
                    share(.fit, "FIT (Garmin)", "Für Garmin-Radcomputer", ready: ready)
                    share(.richiRoute, "RichiRoute-Datei", "Zum Weiterbearbeiten")
                } label: {
                    Label("Teilen", systemImage: "square.and.arrow.up")
                }
                .disabled(!planner.hasRoute)
            }
            if planner.hasShapes {
                Button("Formpunkte entfernen", systemImage: "eraser", action: planner.removeShapes)
            }
        } label: {
            Image(systemName: "ellipsis")
                .font(.system(size: 18, weight: .medium))
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .foregroundStyle(Color.ink)
        .accessibilityLabel("Weitere Aktionen")
    }

    /// A format to share, its use beneath; until `ready`, why it waits.
    private func share(_ format: Planner.Export, _ title: String, _ detail: String, ready: Bool = true) -> some View {
        Button {
            Task { if let files = await planner.export(format) { Share.present(files) } }
        } label: {
            Text(title)
            Text(ready ? detail : "Erst wenn die Route berechnet ist")
        }
        .disabled(!ready)
    }
}

/// The route: its figures, its stops and its surfaces, each shown once, as the web planner's Route tab.
struct RouteTab: View {
    @Bindable var planner: Planner
    /// Whether the panel is folded down, where it shows the route's name and figures.
    let folded: Bool
    let credits: String
    /// Folds the panel, so the map is free for picking a point.
    let fold: () -> Void
    let halve: () -> Void
    @State private var searching: Searching?
    /// The profile with the legs and the stretch it was made from, shown together until the next one is there.
    @State private var shown: (profile: Profile, legs: [Leg], range: ClosedRange<Double>?)?
    /// Whether many Zwischenstopps show one by one rather than as one row.
    @State private var viasOpen = false
    /// The route's surfaces with the legs they were made from, likewise.
    @State private var surfaces: (value: Surfaces, legs: [Leg])?
    /// The rules' notices on stretches the route passes.
    @State private var notices: [RouteNotices.Notice] = []

    /// The stop whose search is open, by its place among the stops and their number with it: a new Zwischenstopp
    /// is one not on the route yet, before the Ziel.
    private struct Searching: Identifiable {
        let id: UUID
        let index: Int
        let count: Int
    }

    private static let top = "summary"
    private static let profileRow = "profile"

    var body: some View {
        ScrollViewReader { scroller in
        List {
            if let loops = planner.loops {
                LoopsView(planner: planner, loops: loops)
            } else {
            Section { summary.id(Self.top) }
            // as on the planner: the rules' notices, then what went wrong
            if !notices.isEmpty {
                Section {
                    ForEach(notices) { notice in
                        // only the sign in the warning colour
                        Label {
                            Text(notice.text)
                        } icon: {
                            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                        }
                        .font(.subheadline)
                    }
                }
            }
            if let problem = planner.problem {
                Section { problemView(problem.message, leg: problem.leg) }
            }
            // under the figures, so the half-raised panel shows the profile with the map above it
            if planner.isComplete, let shown {
                Section {
                    ElevationProfile(profile: shown.profile, legs: shown.legs, range: shown.range) { point in
                        planner.showPoint(point?.coordinate)
                    } zoom: { range in
                        let (profile, legs) = (shown.profile, shown.legs)
                        planner.zoomProfile(range, parts: range.map { profile.parts(from: $0.lowerBound, to: $0.upperBound) } ?? [],
                                            ends: range.map { [$0.lowerBound, $0.upperBound].compactMap { profile.point(at: $0, legs: legs)?.coordinate } } ?? [],
                                            legs: legs)
                        if range != nil {
                            halve()
                            withAnimation { scroller.scrollTo(Self.profileRow, anchor: .top) }
                        }
                    }
                    .padding(.vertical, 4)
                    .id(Self.profileRow)
                }
            }
            Section {
                // a row rather than the list's section header, which brings a large gap of its own
                Text("Wegpunkte").font(.headline).foregroundStyle(Color.ink).listRowSeparator(.hidden)
                stops
            }
            if planner.isComplete, let surfaces {
                Section {
                    // a row, as "Wegpunkte": one heading style in the panel
                    HStack(alignment: .firstTextBaseline) {
                        Text("Untergrund").font(.headline).foregroundStyle(Color.ink)
                        Spacer()
                        SurfaceProgress(planner: planner)
                    }
                    .listRowSeparator(.hidden)
                    SurfaceRows(surfaces: surfaces.value, focused: planner.sectionRange) { range, parts in
                        planner.focusSection(range, parts: parts, legs: surfaces.legs)
                        if range != nil { halve() }
                    }
                }
            }
            }
            // the map's credits, once, at the very end
            Text(credits)
                .font(.caption)
                .foregroundStyle(.secondary)
                .listRowSeparator(.hidden)
                .padding(.top, 8)
        }
        .listStyle(.plain)
        .tint(Color.ink)
        // folded, the panel shows its start again, not wherever it was scrolled to
        .onChange(of: folded) { if folded { withAnimation { scroller.scrollTo(Self.top, anchor: .top) } } }
        // a section on the map: its arrows and list in view above the half-lowered panel's foot, once they are there
        .onChange(of: planner.sectionRange) {
            if planner.sectionRange != nil { withAnimation { scroller.scrollTo(SurfaceRows.stepRow, anchor: .top) } }
        }
        // a tapped row scrolls into view; once its search is done, the folded panel shows its start again
        .onChange(of: searching == nil) { if searching == nil && folded { withAnimation { scroller.scrollTo(Self.top, anchor: .top) } } }
        }
        // what the rules say about stretches of the route, looked at again whenever a leg changes
        .task(id: planner.routedLegs) {
            let legs = legs
            let found = await Task.detached { RouteNotices.along(legs) }.value
            if !Task.isCancelled { notices = found }
        }
        // the surfaces of the route as it stands, asked again whenever a leg changes, also when a track's are found
        .task(id: planner.isComplete ? planner.routedLegs : []) {
            guard planner.isComplete, let engine = planner.engine else { return surfaces = nil }
            let legs = legs
            guard let value = try? await engine.surfaces(legs), !Task.isCancelled else { return }
            surfaces = (value, legs)
        }
        // the profile of the route as it stands, or of its stretch: asked again whenever a leg or the stretch changes
        .task(id: ProfileRequest(route: planner.isComplete ? planner.pairs.map(\.key) : [], range: planner.profileRange)) {
            guard planner.isComplete, let engine = planner.engine else { return shown = nil }
            let (legs, range) = (legs, planner.profileRange)
            let profile = try? await engine.profile(legs, range: range)
            guard !Task.isCancelled else { return }
            // a stretch without a profile (no heights there): back to the whole route rather than none
            if profile == nil && range != nil { return planner.zoomProfile(nil) }
            shown = profile.map { ($0, legs, range) }
        }
        .sheet(item: $searching) { stop in
            StopSearch(title: Planner.label(at: stop.index, of: stop.count), engine: planner.engine, near: planner.focus) { coord, name in
                planner.choose(stop.id, at: coord, name: name)
            } pickOnMap: {
                planner.pick(stop.id)
                fold()
            }
        }
    }

    private var legs: [Leg] { planner.routedLegs.compactMap { $0 } }

    private struct ProfileRequest: Equatable {
        let route: [String]
        let range: ClosedRange<Double>?
    }

    // MARK: Summary

    /// What the folded panel shows: the route's figures and its surfaces at a glance, or what is going on.
    private var summary: some View {
        // folded, the route's lines unseen beneath: every state is as tall, so the panel always ends under them
        ZStack(alignment: .topLeading) {
            if folded {
                VStack(alignment: .leading, spacing: 10) {
                    Text(" ").font(.headline)
                    figure(" ", " ")
                    Rectangle().frame(height: 6)
                }
                .hidden()
            }
            summaryContent
        }
        .padding(.vertical, 4)
        // a tap on the route's name and figures shows all of it, as Apple Maps' route card does
        .contentShape(Rectangle())
        .onTapGesture(perform: showWhole)
        .accessibilityAction(named: "Ganze Route zeigen", showWhole)
    }

    private func showWhole() {
        if !planner.routedLegs.isEmpty { planner.frame(whole: true) }
    }

    private var summaryContent: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let title = planner.heading {
                Text(title).font(.headline).lineLimit(1)
            }
            if planner.isComplete && !planner.isRouting {
                Grid(alignment: .leading, horizontalSpacing: 8) {
                    GridRow {
                        figure("Distanz", "\(Format.km(planner.distanceMeters)) km")
                        figure("Anstieg", planner.ascentMeters.map { "\(Format.whole($0)) hm" } ?? "unbekannt")
                        figure("Höchster Punkt", planner.highestMeters.map { "\(Format.whole($0)) m" } ?? "unbekannt")
                    }
                }
                if let surfaces { SurfaceBar(surfaces: surfaces.value) }
            } else {
                Text(status).font(.subheadline).foregroundStyle(.secondary)
                if planner.isRouting {
                    // looked at four times a second, so the bar comes after the first second and moves evenly
                    TimelineView(.periodic(from: .now, by: 0.25)) { _ in
                        if let progress = planner.routingProgress {
                            ProgressView(value: progress).animation(.linear(duration: 0.25), value: progress)
                        }
                    }
                }
                // with only a Start, in sight on the folded panel
                if planner.stops.count == 2, planner.stops[0].coord != nil, planner.stops[1].coord == nil {
                    Button {
                        planner.openLoops()
                        halve()
                    } label: {
                        Label("Runde vorschlagen", systemImage: "arrow.triangle.capsulepath")
                    }
                    .buttonStyle(.bordered)
                }
            }
        }
    }

    private var status: String {
        if planner.engineMissing { return "Die Routing-Engine startet nicht: Routing-Daten fehlen." }
        if planner.engine == nil { return "Routing-Engine startet …" }
        if planner.isRouting { return "Wird berechnet …" }
        return "Tipp: Antippen setzt Start und Ziel, ein Tippen auf die Route einen Zwischenstopp."
    }

    private func problemView(_ problem: String, leg: Planner.Pair?) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(problem, systemImage: "exclamationmark.triangle").foregroundStyle(Color.danger)
            HStack {
                if let leg {
                    Button("Abschnitt zeigen") {
                        planner.show(leg)
                        halve()
                    }
                }
                Button("Erneut versuchen") { planner.retry() }
            }
            .buttonStyle(.bordered)
        }
        .font(.subheadline)
    }

    // MARK: Stops

    /// Start and Ziel, and the Zwischenstopps between them; from four on, those are one row that opens them, as a
    /// disclosure does, and opens by itself when one is added.
    private var stops: some View {
        let waypoints = planner.waypoints, vias = Array(waypoints.dropFirst().dropLast())
        let grouped = vias.count >= Self.groupedFrom, last = waypoints.count - 1
        // all in one list, each stop dragged anywhere, as in Apple Maps: one let go at the top is the new Start
        var rows = [StopListRow(id: waypoints[0].id, index: 0)]
        if grouped { rows.append(StopListRow(id: Self.foldedID, index: nil)) }
        if !grouped || viasOpen { rows += vias.indices.map { StopListRow(id: vias[$0].id, index: $0 + 1) } }
        rows.append(StopListRow(id: waypoints[last].id, index: last))
        // a row's place among the stops: the folded Zwischenstopps' row before the first, the end after the Ziel
        let place = { (row: Int) in row < rows.count ? rows[row].index ?? 1 : waypoints.count }
        return Group {
            ForEach(rows) { row in
                if let index = row.index {
                    let fixed = index == 0 || index == last
                    stopRow(waypoints[index], at: index)
                        .listRowBackground(planner.picking == row.id ? Color.ink.opacity(0.08) : nil)
                        .moveDisabled(!planner.hasRoute)
                        .deleteDisabled(fixed)
                } else {
                    viasRow(vias.count).moveDisabled(true).deleteDisabled(true)
                }
            }
            .onDelete { offsets in offsets.map { rows[$0].id }.forEach(planner.remove) }
            .onMove { source, destination in planner.moveStops(from: IndexSet(source.map(place)), to: place(destination)) }
            if planner.hasRoute {
                // its search first, so a Zwischenstopp is added once chosen, never empty
                Button { searching = Searching(id: UUID(), index: waypoints.count - 1, count: waypoints.count + 1) } label: {
                    Label("Zwischenstopp hinzufügen", systemImage: "plus")
                }
            }
        }
        .onChange(of: vias.count) { before, now in if now > before { viasOpen = true } }
    }

    private static let groupedFrom = 4
    private static let foldedID = UUID()

    /// A row of the stops: a stop, by its place in `waypoints`, or (no place) the row the Zwischenstopps fold into.
    private struct StopListRow: Identifiable {
        let id: UUID
        let index: Int?
    }

    private func viasRow(_ count: Int) -> some View {
        Button {
            withAnimation { viasOpen.toggle() }
        } label: {
            HStack(spacing: 12) {
                Color.clear.frame(width: 24, height: 24)
                Text("\(count) Zwischenstopps").foregroundStyle(.primary)
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.tertiary)
                    .rotationEffect(.degrees(viasOpen ? 90 : 0))
            }
            .contentShape(Rectangle())
        }
        // the dots run on through it
        .background(alignment: .leading) { Dots().frame(width: 24).padding(.vertical, -12) }
        .alignmentGuide(.listRowSeparatorLeading) { $0[.leading] + 36 }
        .accessibilityAddTraits(viasOpen ? .isSelected : [])
        .accessibilityHint(viasOpen ? "Schließt die Zwischenstopps" : "Zeigt die Zwischenstopps")
    }

    /// Dots from badge to badge, as the planner's, with room around each badge.
    private func dots(above: Bool, below: Bool) -> some View {
        VStack(spacing: 0) {
            Dots().opacity(above ? 1 : 0)
            Color.clear.frame(height: 32)
            Dots().opacity(below ? 1 : 0)
        }
        .frame(width: 24)
        .padding(.vertical, -12)
    }

    /// A stop: tapping it replaces it by a tap on the map; a Zwischenstopp also has its × to remove it.
    private func stopRow(_ stop: Planner.Stop, at index: Int) -> some View {
        let count = planner.waypoints.count, error = planner.stopErrors[stop.id]
        let removable = index > 0 && index < count - 1
        // held and dragged, a stop changes places with another, as in Apple Maps: its grip shows that
        let movable = planner.hasRoute
        return HStack(spacing: 12) {
            // an empty Start or Ziel as an empty ring, as the planner's
            Text(Planner.badge(at: index, of: count))
                .font(.caption.bold())
                .foregroundStyle(stop.coord == nil ? AnyShapeStyle(.secondary) : AnyShapeStyle(.white))
                .frame(width: 24, height: 24)
                .background {
                    if stop.coord == nil {
                        Circle().strokeBorder(.secondary, style: StrokeStyle(lineWidth: 2, dash: [3, 3]))
                    } else {
                        // with the map markers' white ring, which keeps it in sight on the dark panel
                        Circle().fill(Color(error == nil ? MapStyle.ink : MapStyle.danger)).overlay(Circle().strokeBorder(.white, lineWidth: 1.5))
                    }
                }
            VStack(alignment: .leading, spacing: 2) {
                if let coord = stop.coord {
                    Text(planner.names[coord] ?? Format.coordinate(coord))
                } else {
                    Text("\(Planner.label(at: index, of: count)): Karte antippen").foregroundStyle(.secondary)
                }
                if planner.snapping[stop.id] != nil {
                    Text("Straßenpunkt wird gesucht …").font(.caption).foregroundStyle(.secondary)
                } else if let error {
                    Text(error).font(.caption).foregroundStyle(Color.danger)
                }
            }
            Spacer(minLength: 0)
            if removable {
                Button { planner.remove(stop.id) } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(.secondary)
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.borderless)
                .padding(.trailing, movable ? -10 : -12)
                .accessibilityLabel("\(Planner.label(at: index, of: count)) entfernen")
            }
            // a sign, not a button: the whole row is held to drag it
            if movable {
                Image(systemName: "line.3.horizontal")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(.tertiary)
                    .accessibilityHidden(true)
            }
        }
        // the rows' lines start at the text, clear of the dots
        .background(alignment: .leading) { dots(above: index > 0, below: index < count - 1) }
        .alignmentGuide(.listRowSeparatorLeading) { $0[.leading] + 36 }
        .contentShape(Rectangle())
        .onTapGesture { searching = Searching(id: stop.id, index: index, count: count) }
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isButton)
        .accessibilityHint("Öffnet die Suche für diesen Punkt")
    }

    // MARK: Figures and surfaces

    private func figure(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.caption).foregroundStyle(.secondary)
            Text(value).font(.title3.weight(.semibold))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// A dotted line down the middle of its frame.
private struct Dots: View {
    var body: some View {
        GeometryReader { size in
            Path { path in
                path.move(to: CGPoint(x: size.size.width / 2, y: 0))
                path.addLine(to: CGPoint(x: size.size.width / 2, y: size.size.height))
            }
            .stroke(Color.secondary.opacity(0.7), style: StrokeStyle(lineWidth: 2.6, lineCap: .round, dash: [0, 7], dashPhase: 3.5))
        }
    }
}

/// How far the search for a track's surfaces has come; a view of its own, so each step redraws only this.
private struct SurfaceProgress: View {
    let planner: Planner

    var body: some View {
        if let progress = planner.surfaceProgress {
            Text("Wird ermittelt … \(Int(progress * 100)) %").font(.subheadline).foregroundStyle(.secondary).monospacedDigit()
        }
    }
}
