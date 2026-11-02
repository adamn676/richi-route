import SwiftUI

/// The route panel: its figures, its stops and its surfaces, each shown once, as the web planner's Route tab.
struct RouteSheet: View {
    @Bindable var planner: Planner
    /// Whether the panel is folded down, where it shows the route's name and figures.
    let folded: Bool
    /// Folds the panel, so the map is free for picking a point.
    let fold: () -> Void
    @State private var searching: Searching?
    @State private var profile: Profile?

    /// The stop whose search is open.
    private struct Searching: Identifiable {
        let id: UUID
        let index: Int
    }

    private static let ink = Color(MapStyle.ink)
    private static let top = "summary"
    private static let danger = Color(MapStyle.danger)

    var body: some View {
        ScrollViewReader { scroller in
        List {
            Section { summary.id(Self.top) }
            if let problem = planner.problem {
                Section { problemView(problem) }
            }
            Section {
                // a row rather than the list's section header, which brings a large gap of its own
                stopsHeader.listRowSeparator(.hidden)
                stops
            }
            if planner.isComplete {
                if let profile {
                    Section { ElevationProfile(profile: profile).padding(.vertical, 4) }
                }
                Section {
                    // a row, as "Wegpunkte": one heading style in the panel
                    Text("Untergrund").font(.headline).foregroundStyle(Self.ink).listRowSeparator(.hidden)
                    surfaces
                }
            }
            // the map's credits, once, at the very end
            Text("© OpenStreetMap · Österr. Adressregister")
                .font(.caption)
                .foregroundStyle(.secondary)
                .listRowSeparator(.hidden)
                .padding(.top, 8)
        }
        .listStyle(.plain)
        .tint(Self.ink)
        // folded, the panel shows its start again, not wherever it was scrolled to
        .onChange(of: folded) { if folded { withAnimation { scroller.scrollTo(Self.top, anchor: .top) } } }
        // a tapped row scrolls into view; once its search is done, the folded panel shows its start again
        .onChange(of: searching == nil) { if searching == nil && folded { withAnimation { scroller.scrollTo(Self.top, anchor: .top) } } }
        }
        // the profile of the route as it stands: asked again whenever a leg changes
        .task(id: planner.isComplete ? planner.pairs.map(\.key) : []) {
            guard planner.isComplete, let engine = planner.engine else { return profile = nil }
            let legs = planner.routedLegs.compactMap { $0 }
            profile = try? await engine.profile(legs)
        }
        .sheet(item: $searching) { stop in
            StopSearch(title: Planner.label(at: stop.index, of: planner.stops.count), engine: planner.engine, near: planner.focus) { coord, name in
                planner.choose(stop.id, at: coord, name: name)
            } pickOnMap: {
                planner.pick(stop.id)
                fold()
            }
        }
    }

    // MARK: Summary

    /// What the folded panel shows: the route's figures and its surfaces at a glance, or what is going on.
    private var summary: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let title = planner.title {
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
                surfaceBar
            } else {
                Text(status).font(.subheadline).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 4)
    }

    private var status: String {
        if planner.engineMissing { return "Die Routing-Engine startet nicht: Routing-Daten fehlen." }
        if planner.engine == nil { return "Routing-Engine startet …" }
        if planner.isRouting { return "Wird berechnet …" }
        return "Tipp: Antippen setzt Start und Ziel, ein Tippen auf die Route einen Zwischenstopp."
    }

    private var surfaceBar: some View {
        let parts = planner.surfaceMeters, total = parts.reduce(0) { $0 + $1.meters }
        return GeometryReader { size in
            HStack(spacing: 0) {
                ForEach(parts, id: \.surface) { part in
                    Rectangle().fill(Color(MapStyle.shared.color(part.surface))).frame(width: size.size.width * part.meters / total)
                }
            }
        }
        .frame(height: 6)
        .clipShape(Capsule())
        .accessibilityElement()
        .accessibilityLabel("Untergrund: " + parts.map { "\(percent($0.meters, of: total)) % \($0.surface.label)" }.joined(separator: ", "))
    }

    private func problemView(_ problem: (message: String, pair: Int)) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(problem.message, systemImage: "exclamationmark.triangle").foregroundStyle(Self.danger)
            Button("Erneut versuchen") { planner.retry() }.buttonStyle(.bordered)
        }
        .font(.subheadline)
    }

    // MARK: Stops

    private var stopsHeader: some View {
        HStack(spacing: 0) {
            Text("Wegpunkte").font(.headline).foregroundStyle(Self.ink)
            Spacer()
            Button(action: planner.undo) { toolIcon("arrow.uturn.backward") }
                .disabled(!planner.canUndo).accessibilityLabel("Rückgängig")
            Button(action: planner.redo) { toolIcon("arrow.uturn.forward") }
                .disabled(!planner.canRedo).accessibilityLabel("Wiederholen")
            Menu {
                Button("Neue Route", systemImage: "plus", action: planner.newRoute)
            } label: { toolIcon("ellipsis") }
                .accessibilityLabel("Weitere Aktionen")
                // the last glyph at the margin, as the planner's tools; its target reaches past it
                .padding(.trailing, -12)
        }
        .buttonStyle(.borderless)
        .textCase(nil)
    }

    /// A tool's glyph with Apple's smallest target for a finger, 44 × 44 points.
    private func toolIcon(_ symbol: String) -> some View {
        Image(systemName: symbol)
            .font(.system(size: 18, weight: .medium))
            .frame(width: 44, height: 44)
            .contentShape(Rectangle())
    }

    private var stops: some View {
        Group {
            ForEach(Array(planner.stops.enumerated()), id: \.element.id) { index, stop in
                let end = index == 0 || index == planner.stops.count - 1
                stopRow(stop, at: index, removable: !end)
                    .moveDisabled(end)
                    .deleteDisabled(end)
                    .listRowBackground(planner.picking == stop.id ? Self.ink.opacity(0.08) : nil)
            }
            .onDelete { offsets in offsets.map { planner.stops[$0].id }.forEach(planner.remove) }
            .onMove(perform: planner.moveStops)
            if planner.stops.first?.coord != nil, planner.stops.last?.coord != nil {
                Button { planner.addStop() } label: {
                    Label("Zwischenstopp hinzufügen", systemImage: "plus")
                }
            }
        }
    }

    /// A stop: tapping it replaces it by a tap on the map; a Zwischenstopp also has its × to remove it.
    private func stopRow(_ stop: Planner.Stop, at index: Int, removable: Bool) -> some View {
        let count = planner.stops.count, error = planner.stopErrors[stop.id]
        return HStack(spacing: 12) {
            Text(Planner.badge(at: index, of: count))
                .font(.caption.bold())
                .foregroundStyle(.white)
                .frame(width: 24, height: 24)
                .background(error == nil ? Self.ink : Self.danger, in: Circle())
            VStack(alignment: .leading, spacing: 2) {
                if let coord = stop.coord {
                    Text(planner.names[coord] ?? Format.coordinate(coord))
                } else {
                    Text("\(Planner.label(at: index, of: count)): Karte antippen").foregroundStyle(.secondary)
                }
                if planner.snapping[stop.id] != nil {
                    Text("Straßenpunkt wird gesucht …").font(.caption).foregroundStyle(.secondary)
                } else if let error {
                    Text(error).font(.caption).foregroundStyle(Self.danger)
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
                .padding(.trailing, -12)
                .accessibilityLabel("\(Planner.label(at: index, of: count)) entfernen")
            }
        }
        .contentShape(Rectangle())
        .onTapGesture { searching = Searching(id: stop.id, index: index) }
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

    private var surfaces: some View {
        let parts = planner.surfaceMeters, total = parts.reduce(0) { $0 + $1.meters }
        return ForEach(parts, id: \.surface) { part in
            HStack(spacing: 10) {
                Circle().fill(Color(MapStyle.shared.color(part.surface))).frame(width: 10, height: 10)
                Text(part.surface.label)
                Spacer()
                Text("\(Format.km(part.meters)) km")
                Text("\(percent(part.meters, of: total)) %").foregroundStyle(.secondary).frame(width: 44, alignment: .trailing)
            }
            .font(.subheadline)
        }
    }

    private func percent(_ part: Double, of total: Double) -> Int { total > 0 ? Int((part / total * 100).rounded()) : 0 }
}
