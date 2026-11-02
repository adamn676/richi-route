import Foundation
import Observation

/// The route being planned, as the web planner's route store keeps it: Start, Zwischenstopps and Ziel, each
/// snapped to the nearest road by the engine, and a leg routed between each pair of placed neighbours.
@MainActor @Observable
final class Planner {
    struct Stop: Identifiable, Equatable, Sendable {
        let id: UUID
        var coord: [Double]?

        init(_ coord: [Double]? = nil) {
            id = UUID()
            self.coord = coord
        }
    }

    enum LegState: Equatable {
        case routing
        case routed(Leg)
        case failed(String)
    }

    struct Pair {
        let from: Stop
        let to: Stop
        let key: String
    }

    var engine: Engine?
    private(set) var engineMissing = false
    private(set) var stops = [Stop(), Stop()]
    /// Legs by their ends; routed ones stay, so undo and redo bring them back at once.
    private(set) var legs: [String: LegState] = [:]
    /// The leg requests running, by their ends; one no longer needed is cancelled, which stops its search.
    private var requests: [String: Task<Void, Never>] = [:]
    /// Stops waiting for their road, with the point asked about, and those placed where none is near.
    private(set) var snapping: [UUID: [Double]] = [:]
    private(set) var stopErrors: [UUID: String] = [:]
    /// Points the engine gave as the nearest road, which need no asking again, and the names of those it knows.
    private var onRoad: Set<[Double]> = []
    private(set) var names: [[Double]: String] = [:]
    /// The names of places chosen in the search, given to their stops once on the road.
    private var chosen: [UUID: String] = [:]
    /// The map's centre, which searches prefer places near.
    @ObservationIgnored var focus: [Double]?
    /// Counts the requests to frame the route; the map frames it when the count changes.
    private(set) var framing = 0
    /// The stop the rider is replacing: the next tap on the map puts it there.
    private(set) var picking: UUID?
    /// What the phone lets the rider feel, a new value each time (`PlannerView`).
    private(set) var feedback = Feedback(kind: .tap, count: 0)
    private var undos: [[Stop]] = []
    private var redos: [[Stop]] = []

    static let maxSnapMeters = 250.0
    static let longSearch = Duration.seconds(3)

    func start() async {
        engine = await Engine.start()
        engineMissing = engine == nil
        for stop in stops where stop.coord != nil { snap(stop.id) }
    }

    // MARK: Editing, each change one undo step

    /// A tap on the map: the stop being replaced, else the first empty place (Start, Ziel, then a Zwischenstopp);
    /// with all set, the route goes on from its Ziel, which becomes a Zwischenstopp.
    func place(_ coord: [Double]) {
        if let picking {
            self.picking = nil
            return move(picking, to: coord)
        }
        change {
            if let empty = stops.firstIndex(where: { $0.coord == nil }) {
                stops[empty].coord = coord
                return stops[empty].id
            }
            stops.append(Stop(coord))
            return stops[stops.count - 1].id
        }
    }

    /// A tap on the route: a Zwischenstopp there, on the leg `pair` (an index into `pairs`).
    func insert(_ coord: [Double], onLeg pair: Int) {
        guard pairs.indices.contains(pair), let at = stops.firstIndex(where: { $0.id == pairs[pair].to.id }) else { return place(coord) }
        change {
            stops.insert(Stop(coord), at: at)
            return stops[at].id
        }
    }

    /// A stop put at a place found in the search, which keeps the place's name; without one the road's is looked up.
    func choose(_ id: UUID, at coord: [Double], name: String?) {
        chosen[id] = name
        move(id, to: coord)
    }

    func move(_ id: UUID, to coord: [Double]) {
        change {
            guard let at = stops.firstIndex(where: { $0.id == id }) else { return nil }
            stops[at].coord = coord
            return id
        }
    }

    /// Removes a Zwischenstopp; Start and Ziel are emptied instead.
    func remove(_ id: UUID) {
        change {
            guard let at = stops.firstIndex(where: { $0.id == id }) else { return nil }
            if at == 0 || at == stops.count - 1 { stops[at].coord = nil } else { stops.remove(at: at) }
            return nil
        }
    }

    /// An empty Zwischenstopp before the Ziel, which the next tap on the map fills.
    func addStop() {
        change {
            stops.insert(Stop(), at: stops.count - 1)
            return nil
        }
    }

    /// Reorders Zwischenstopps among themselves; Start and Ziel keep their places.
    func moveStops(from source: IndexSet, to destination: Int) {
        guard source.allSatisfy({ $0 > 0 && $0 < stops.count - 1 }) else { return }
        change {
            stops.move(fromOffsets: source, toOffset: min(max(destination, 1), stops.count - 1))
            return nil
        }
    }

    /// Starts replacing a stop by a tap on the map; picking it again ends that.
    func pick(_ id: UUID) {
        picking = picking == id ? nil : id
    }

    func cancelPick() { picking = nil }

    func newRoute() {
        change {
            stops = [Stop(), Stop()]
            return nil
        }
    }

    var canUndo: Bool { !undos.isEmpty }
    var canRedo: Bool { !redos.isEmpty }

    func undo() {
        guard let previous = undos.popLast() else { return }
        redos.append(stops)
        restore(previous)
        feel(.tap)
    }

    func redo() {
        guard let next = redos.popLast() else { return }
        undos.append(stops)
        restore(next)
        feel(.tap)
    }

    /// Asks again for the legs that failed and the roads of the stops that found none.
    func retry() {
        legs = legs.filter { if case .failed = $0.value { false } else { true } }
        for id in Array(stopErrors.keys) { snap(id) }
        update()
    }

    func frame() { framing += 1 }

    /// `edit` changes the stops and returns the one it placed, whose road is then looked up.
    private func change(_ edit: () -> UUID?) {
        picking = nil
        let before = stops
        let placed = edit()
        guard stops != before else { return }
        undos.append(before)
        redos.removeAll()
        if let placed { snap(placed) }
        update()
        feel(.tap)
    }

    private func feel(_ kind: Feedback.Kind) { feedback = Feedback(kind: kind, count: feedback.count + 1) }

    /// Brings back saved stops; those not known to lie on a road are looked up again, which also brings back or
    /// clears their errors.
    private func restore(_ saved: [Stop]) {
        picking = nil
        stops = saved
        let ids = Set(stops.map(\.id))
        stopErrors = stopErrors.filter { ids.contains($0.key) }
        snapping = snapping.filter { ids.contains($0.key) }
        for stop in stops {
            guard let coord = stop.coord else { stopErrors[stop.id] = nil; continue }
            if onRoad.contains(coord) { stopErrors[stop.id] = nil } else if snapping[stop.id] != coord { snap(stop.id) }
        }
        update()
    }

    // MARK: Snapping and routing

    private func snap(_ id: UUID) {
        guard let engine, let coord = stops.first(where: { $0.id == id })?.coord else { return }
        stopErrors[id] = nil
        guard !onRoad.contains(coord) else { return }
        snapping[id] = coord
        Task {
            let result: Result<[Double], Engine.Failure>
            do {
                let snapped = try await engine.leg([coord]).coordinates.first
                result = if let snapped, Geo.distance(coord, snapped) <= Self.maxSnapMeters {
                    .success(snapped)
                } else {
                    .failure(Engine.Failure(message: "Kein geeigneter Radweg innerhalb von \(Format.whole(Self.maxSnapMeters))\u{a0}m. Bitte den Punkt näher an eine Straße setzen."))
                }
            } catch {
                result = .failure(Self.failure(error))
            }
            // a later change may have moved, removed or looked up the stop again meanwhile
            guard snapping[id] == coord else { return }
            snapping[id] = nil
            if let at = stops.firstIndex(where: { $0.id == id }), stops[at].coord == coord {
                switch result {
                case .success(let snapped):
                    onRoad.insert(snapped)
                    stops[at].coord = snapped
                    if let name = chosen.removeValue(forKey: id) {
                        names[snapped] = name
                    } else if names[snapped] == nil {
                        // beside the routing, which need not wait for it
                        Task { if let name = await engine.name(snapped) { names[snapped] = name } }
                    }
                case .failure(let failure):
                    stopErrors[id] = failure.message
                    feel(.warning)
                }
            }
            update()
        }
    }

    /// Neighbouring stops that are placed on a road, in order.
    var pairs: [Pair] {
        let placed = stops.filter { $0.coord != nil && snapping[$0.id] == nil && stopErrors[$0.id] == nil }
        return zip(placed, placed.dropFirst()).map { Pair(from: $0, to: $1, key: Self.key($0.coord!, $1.coord!)) }
    }

    private static func key(_ from: [Double], _ to: [Double]) -> String { "\(from[0]),\(from[1])|\(to[0]),\(to[1])" }

    /// Routes the legs the stops need and cancels the searches for those they no longer do.
    private func update() {
        let needed = pairs
        let keys = Set(needed.map(\.key))
        for (key, request) in requests where !keys.contains(key) {
            request.cancel()
            requests[key] = nil
            legs[key] = nil
        }
        guard let engine else { return }
        for pair in needed where legs[pair.key] == nil {
            legs[pair.key] = .routing
            let points = [pair.from.coord!, pair.to.coord!]
            requests[pair.key] = Task {
                let started = ContinuousClock.now
                let state: LegState
                do { state = .routed(try await engine.leg(points)) } catch { state = .failed(Self.failure(error).message) }
                guard !Task.isCancelled else { return }
                requests[pair.key] = nil
                legs[pair.key] = state
                if case .failed = state {
                    feel(.warning)
                } else if started.duration(to: .now) > Self.longSearch, !isRouting {
                    // the rider has waited for it, perhaps with the phone aside
                    feel(.done)
                }
            }
        }
    }

    /// The engine's failures in the planner's words (`src/services/route.service.ts`).
    private static func failure(_ error: Error) -> Engine.Failure {
        guard let detail = (error as? Engine.Failure)?.message else {
            return Engine.Failure(message: "Die Routing-Engine antwortet nicht. Bitte die App neu starten.")
        }
        if detail == "memory limit reached" {
            return Engine.Failure(message: "Die Routenberechnung hat das Speicherlimit erreicht, der Abschnitt ist zu weit. Bitte einen Zwischenstopp dazwischen setzen.")
        }
        if detail.range(of: #"timeout after \d+ seconds|operation killed by thread-priority-watchdog"#, options: .regularExpression) != nil {
            return Engine.Failure(message: "Die Routenberechnung hat das Zeitlimit erreicht. Bitte einen Zwischenstopp dazwischen setzen.")
        }
        if detail.range(of: #"^no track found\b|position not mapped in existing datafile"#, options: .regularExpression) != nil {
            return Engine.Failure(message: "Keine passende Fahrradverbindung gefunden. Bitte Start, Ziel oder Zwischenpunkte verschieben.")
        }
        if let tile = detail.firstMatch(of: /^datafile ([EW]\d+_[NS]\d+\.rd5) not found$/)?.1 {
            return Engine.Failure(message: "Für diese Gegend hat die App keine Routing-Daten (\(tile)).")
        }
        return Engine.Failure(message: "Die Route konnte nicht berechnet werden (\(detail)). Bitte erneut versuchen.")
    }

    // MARK: What the route shows

    /// The legs in order, nil where one is still routed or failed.
    var routedLegs: [Leg?] {
        pairs.map { if case .routed(let leg) = legs[$0.key] { leg } else { nil } }
    }

    var isRouting: Bool { !snapping.isEmpty || legs.values.contains(.routing) }

    /// A route from Start to Ziel with every leg routed.
    var isComplete: Bool {
        stops.allSatisfy { $0.coord != nil } && pairs.count == stops.count - 1 && routedLegs.allSatisfy { $0 != nil }
    }

    var distanceMeters: Double { routedLegs.reduce(0) { $0 + ($1?.distanceMeters ?? 0) } }

    var ascentMeters: Double? {
        let legs = routedLegs
        guard !legs.isEmpty, legs.allSatisfy({ $0?.ascentMeters != nil }) else { return nil }
        return legs.reduce(0) { $0 + $1!.ascentMeters! }
    }

    var highestMeters: Double? { routedLegs.compactMap { $0?.elevations?.max() }.max() }

    /// Metres per surface group, in the groups' order, those the route has.
    var surfaceMeters: [(surface: Surface, meters: Double)] {
        var meters: [Surface: Double] = [:]
        for leg in routedLegs.compactMap({ $0 }) {
            for span in leg.drawnSpans { meters[span.surface, default: 0] += Geo.length(leg.coordinates[span.fromIndex...span.toIndex]) }
        }
        return Surface.allCases.compactMap { surface in meters[surface].flatMap { $0 > 0 ? (surface, $0) : nil } }
    }

    /// The first problem fixed elsewhere than at a stop: a leg that could not be routed.
    var problem: (message: String, pair: Int)? {
        for (index, pair) in pairs.enumerated() { if case .failed(let message) = legs[pair.key] { return (message, index) } }
        return nil
    }

    /// The route's name as the planner gives it (`routeTitle`): "A → B" by its ends' places, "Runde ab A" where they
    /// are one; nil until both ends have one.
    var title: String? {
        guard let first = stops.first?.coord.flatMap({ names[$0] }), let last = stops.last?.coord.flatMap({ names[$0] }) else { return nil }
        let place = { (name: String) in name.split(separator: ",").first.map(String.init) ?? name }
        return place(first) == place(last) ? "Runde ab \(place(first))" : "\(place(first)) → \(place(last))"
    }

    static func label(at index: Int, of count: Int) -> String {
        index == 0 ? "Start" : index == count - 1 ? "Ziel" : "Zwischenstopp \(index)"
    }

    static func badge(at index: Int, of count: Int) -> String {
        index == 0 ? "S" : index == count - 1 ? "Z" : "\(index)"
    }

    var mapContent: MapContent {
        var lines: [MapContent.Line] = []
        for (index, pair) in pairs.enumerated() {
            switch legs[pair.key] {
            case .routed(let leg):
                for span in leg.drawnSpans {
                    lines.append(.init(coordinates: Array(leg.coordinates[span.fromIndex...span.toIndex]), style: span.surface.rawValue, leg: index))
                }
            case .failed: lines.append(.init(coordinates: [pair.from.coord!, pair.to.coord!], style: "air", leg: index))
            case .routing, nil: lines.append(.init(coordinates: [pair.from.coord!, pair.to.coord!], style: "waiting", leg: index))
            }
        }
        let pins = stops.enumerated().compactMap { index, stop in
            stop.coord.map { MapContent.Pin(stop: stop.id, coord: $0, badge: Self.badge(at: index, of: stops.count), error: stopErrors[stop.id] != nil) }
        }
        return MapContent(lines: lines, pins: pins, framing: framing)
    }
}

struct Feedback: Equatable {
    enum Kind {
        /// A stop placed, moved or removed, an undo or redo.
        case tap
        /// A route the rider waited for is there.
        case done
        /// No road near a stop, or a leg that failed.
        case warning
    }

    let kind: Kind
    let count: Int
}

/// What the map draws of the route: its legs by surface (or `waiting`, `air`) and its stops.
struct MapContent: Equatable {
    struct Line: Equatable {
        let coordinates: [[Double]]
        let style: String
        let leg: Int
    }

    struct Pin: Equatable {
        let stop: UUID
        var coord: [Double]
        let badge: String
        let error: Bool
    }

    let lines: [Line]
    let pins: [Pin]
    let framing: Int
}
