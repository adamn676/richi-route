import Foundation
import Observation

/// The route being planned, as the web planner's route store keeps it: Start, Zwischenstopps and Ziel with the
/// Formpunkte between them, each snapped to the nearest road by the engine, and a leg routed between each pair of
/// placed neighbours.
@MainActor @Observable
final class Planner {
    struct Stop: Identifiable, Equatable, Sendable {
        let id: UUID
        var coord: [Double]?
        /// A Formpunkt: it only shapes the route, with no row, badge or name of its own.
        var shape = false

        init(_ coord: [Double]? = nil, id: UUID = UUID(), shape: Bool = false) {
            self.id = id
            self.coord = coord
            self.shape = shape
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
    /// Start, Zwischenstopps, Ziel and the Formpunkte between them, in order.
    private(set) var stops = [Stop(), Stop()]
    /// The stops the rider sees and edits: Start, Zwischenstopps and Ziel.
    var waypoints: [Stop] { stops.filter { !$0.shape } }
    var hasShapes: Bool { stops.contains(where: \.shape) }
    /// Legs by their ends; routed ones stay, so undo and redo bring them back at once.
    private(set) var legs: [String: LegState] = [:]
    /// The leg requests running, by their ends; one no longer needed is cancelled, which stops its search.
    private var requests: [String: Task<Void, Never>] = [:]
    /// How far each leg being routed has come, as the engine estimates it.
    private var progress: [String: Double] = [:]
    /// The legs routed since the planner last had none to route, and when that began: their progress together is
    /// the panel's.
    private var batch: Set<String> = []
    private var batchStarted = ContinuousClock.now
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
    /// The loops suggested from the Start while the rider chooses (`Loops.swift`), and their search.
    var loops: Loops?
    @ObservationIgnored var loopSearch: Task<Void, Never>?
    /// Counts the requests to frame the route; the map frames it when the count changes.
    private(set) var framing = 0
    /// Whether that framing shows the whole route rather than the stretch chosen.
    private var framesWhole = false
    /// Shows the elevation profile's point under the finger on the map. It goes to the map directly as the finger
    /// moves: through SwiftUI, each move would redraw the planner.
    @ObservationIgnored var showPoint: ([Double]?) -> Void = { _ in }
    /// A stretch chosen on the route it was chosen on: its distances along it, the route along it in its surfaces,
    /// which the map brings out, and its line, which the map frames. Kept here, so panel and map show the same stretch,
    /// also after another tab or an undo.
    struct Stretch {
        let route: [String]
        let range: ClosedRange<Double>
        let pieces: [MapContent.Line]
        let line: [[Double]]
    }

    /// The stretch the elevation profile is zoomed into, and the surface section picked in "Untergrund", which the map
    /// shows rather than the stretch.
    private(set) var zoom: Stretch?
    private(set) var section: Stretch?

    var profileRange: ClosedRange<Double>? { current(zoom)?.range }
    var sectionRange: ClosedRange<Double>? { current(section)?.range }

    /// `parts` are the points it covers on each of `legs`, the legs it was chosen on, `[leg, first, last]`; `ends`,
    /// where it begins and ends between two of them.
    func zoomProfile(_ range: ClosedRange<Double>?, parts: [[Int]] = [], ends: [[Double]] = [], legs: [Leg] = []) {
        zoom = range.map { stretch($0, parts: parts, ends: ends, legs: legs) }
        frame()
    }

    func focusSection(_ range: ClosedRange<Double>?, parts: [[Int]] = [], legs: [Leg] = []) {
        section = range.map { stretch($0, parts: parts, ends: [], legs: legs) }
        frame()
    }

    /// A stretch while the route is the one it was chosen on.
    private func current(_ stretch: Stretch?) -> Stretch? { stretch.flatMap { $0.route == pairs.map(\.key) ? $0 : nil } }
    /// The stop the rider is replacing: the next tap on the map puts it there.
    private(set) var picking: UUID?
    /// What the phone lets the rider feel, a new value each time (`PlannerView`).
    private(set) var feedback = Feedback(kind: .tap, count: 0)
    @ObservationIgnored private var saving: Task<Void, Never>?
    /// The saved route this one is, by its id and name, and its stops when it was saved.
    private(set) var savedID: UUID?
    private(set) var savedName: String?
    private var savedStops: [Stop]?
    /// A short note on what just happened to the routes, with the route to bring back where there is one.
    private(set) var notice: Notice?
    private var undos: [[Stop]] = []
    private var redos: [[Stop]] = []
    /// Counts the rider's edits, undo and redo with them.
    private(set) var edits = 0

    static let maxSnapMeters = 250.0
    static let longSearch = Duration.seconds(3)

    func start() async {
        engine = await Engine.start()
        engineMissing = engine == nil
        // the route as it was when the app last closed; the UI tests start without it (`-fresh`), from the same map
        if !ProcessInfo.processInfo.arguments.contains("-fresh"), let (file, id) = RouteStore.current() {
            open(file)
            if let id { mark(saved: id, name: file.name) }
        }
        for stop in stops where stop.coord != nil { snap(stop.id) }
        update()
    }

    // MARK: Saving, in the planner's file format

    /// The route as the planner saves it, with its stops' names and the legs routed so far.
    func file(named name: String) -> RouteFile {
        let points = stops.enumerated().map { index, stop in
            if stop.shape {
                return RouteFile.Point(id: RouteFile.pointID(stop), type: "shape", kind: nil, coord: stop.coord, address: nil, userInput: nil)
            }
            let address = stop.coord.flatMap { names[$0] }
            return RouteFile.Point(id: RouteFile.pointID(stop), type: "stop",
                                   kind: index == 0 ? "start" : index == stops.count - 1 ? "end" : "via",
                                   coord: stop.coord, address: address, userInput: address ?? "")
        }
        var saved: [String: RouteFile.SavedLeg] = [:]
        for pair in pairs {
            guard case .routed(let leg) = legs[pair.key] else { continue }
            let (from, to) = (RouteFile.pointID(pair.from), RouteFile.pointID(pair.to))
            saved["\(from):\(to)"] = RouteFile.SavedLeg(
                id: "\(from):\(to)", fromId: from, toId: to, fromCoord: pair.from.coord!, toCoord: pair.to.coord!,
                coordinates: leg.coordinates, elevations: leg.elevations, surfaces: leg.surfaces,
                distanceMeters: leg.distanceMeters, ascentMeters: leg.ascentMeters, status: "routed", routingPolicy: engine?.policy)
        }
        return RouteFile(name: name, draft: RouteFile.Draft(points: points, legs: saved))
    }

    /// Opens a saved route in place of this one. Its stops keep their names, and legs routed under the app's rules stay;
    /// the others are routed again.
    func open(_ file: RouteFile) {
        // a Formpunkt without its place shapes nothing
        let saved = file.draft.points.filter { $0.type == "stop" || $0.type == "shape" && $0.coord != nil }.map { point in
            Stop(point.coord, id: UUID(uuidString: String(point.id.drop(while: { $0 != "-" }).dropFirst())) ?? UUID(), shape: point.type == "shape")
        }
        guard saved.count(where: { !$0.shape }) >= 2 else { return }
        stops = saved
        stopErrors = [:]
        snapping = [:]
        for point in file.draft.points {
            guard let coord = point.coord else { continue }
            onRoad.insert(coord)
            if let address = point.address { names[coord] = address }
        }
        for leg in file.draft.legs.values where leg.status == "routed" && leg.routingPolicy != nil && leg.routingPolicy == engine?.policy {
            legs[Self.key(leg.fromCoord, leg.toCoord)] = .routed(Leg(
                coordinates: leg.coordinates, elevations: leg.elevations, distanceMeters: leg.distanceMeters,
                ascentMeters: leg.ascentMeters, surfaces: leg.surfaces))
        }
        update()
        frame()
    }

    /// Keeps the route as it stands, a moment after the last change, so the app opens with it again.
    private func remember() {
        saving?.cancel()
        saving = Task {
            try? await Task.sleep(for: .milliseconds(500))
            guard !Task.isCancelled else { return }
            RouteStore.keep(file(named: name), saved: savedID)
        }
    }

    /// The route's name: as saved, else by its ends.
    var name: String { savedName ?? title ?? "Route" }

    /// Saved and unchanged since.
    var isSaved: Bool { savedID != nil && savedStops == stops }

    var hasRoute: Bool { stops.first?.coord != nil && stops.last?.coord != nil }

    /// A route worth keeping: not a Ziel on its Start with nothing between.
    private var worthKeeping: Bool { hasRoute && (stops.count > 2 || stops.first?.coord != stops.last?.coord) }

    func save(as name: String) {
        mark(saved: RouteStore.store(file(named: name), as: .saved).id, name: name)
        remember()
        notice = Notice(text: "„\(name)“ gespeichert.")
    }

    func saveChanges() {
        guard let savedID, let savedName else { return }
        RouteStore.store(file(named: savedName), as: .saved, id: savedID)
        savedStops = stops
        remember()
        notice = Notice(text: "„\(savedName)“ gespeichert.")
    }

    /// The open route renamed or deleted in "Meine Routen".
    func savedRouteChanged(_ id: UUID, name: String?) {
        guard id == savedID else { return }
        if let name { savedName = name } else { mark(saved: nil, name: nil) }
        remember()
    }

    /// Opens a saved or recent route, or a new one without; the route it replaces goes to "Zuletzt bearbeitet" where
    /// it has Start and Ziel and is not saved as it stands.
    func replace(with entry: RouteStore.Entry?) {
        let file = entry.flatMap(RouteStore.file)
        var kept: RouteStore.Entry?
        if worthKeeping && !isSaved {
            kept = RouteStore.store(self.file(named: name), as: .recent)
        }
        if let file {
            open(file)
            mark(saved: entry?.kind == .saved ? entry?.id : nil, name: file.name)
        } else {
            restore([Stop(), Stop()])
            mark(saved: nil, name: nil)
        }
        // a history of its own, as the planner's (`restoreDraft`): the route replaced comes back with "Wiederherstellen"
        undos.removeAll()
        redos.removeAll()
        if entry?.kind == .recent, let entry { RouteStore.delete(entry) }
        // an opened route shows itself on the map, unconfirmed
        notice = kept.map { Notice(text: "Vorige Route liegt in „Zuletzt bearbeitet“.", restore: $0) }
        remember()
    }

    func dismissNotice() { notice = nil }

    private func mark(saved id: UUID?, name: String?) {
        savedID = id
        savedName = id == nil ? nil : name
        savedStops = id == nil ? nil : stops
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

    /// The route dragged on the leg `pair`: a Formpunkt where it was let go.
    func shape(_ coord: [Double], onLeg pair: Int) {
        guard pairs.indices.contains(pair), let at = stops.firstIndex(where: { $0.id == pairs[pair].to.id }) else { return }
        change {
            stops.insert(Stop(coord, shape: true), at: at)
            return stops[at].id
        }
    }

    /// "Formpunkte entfernen": the route between the stops again.
    func removeShapes() {
        change {
            stops.removeAll(where: \.shape)
            return nil
        }
    }

    /// A stop put at a place found in the search, which keeps the place's name; without one the road's is looked up.
    func choose(_ id: UUID, at coord: [Double], name: String?) {
        chosen[id] = name
        move(id, to: coord)
        // the map shows it, until the route it completes is there to show (`setWaypointPlace`)
        if !isComplete { frame() }
    }

    /// Puts a stop at `coord`; an `id` the route has not yet is a new Zwischenstopp, before the Ziel (as the planner's
    /// `addIntermediateStopAndPrepare`), so a Zwischenstopp is added only once it has its place.
    func move(_ id: UUID, to coord: [Double]) {
        change {
            if let at = stops.firstIndex(where: { $0.id == id }) {
                stops[at].coord = coord
            } else {
                stops.insert(Stop(coord, id: id), at: stops.count - 1)
            }
            return id
        }
    }

    /// Removes a Zwischenstopp.
    func remove(_ id: UUID) {
        change {
            stops.removeAll { $0.id == id }
            return nil
        }
    }

    /// Reorders the stops (offsets into `waypoints`), Start and Ziel too, as Apple Maps does; the Formpunkte keep their
    /// places (`moveWaypointTo`).
    func moveStops(from source: IndexSet, to destination: Int) {
        var order = waypoints
        order.move(fromOffsets: source, toOffset: destination)
        change {
            var next = order.makeIterator()
            stops = stops.map { $0.shape ? $0 : next.next()! }
            return nil
        }
    }

    /// Starts placing a stop, or a new one, by a tap on the map; picking it again ends that.
    func pick(_ id: UUID) {
        picking = picking == id ? nil : id
    }

    func cancelPick() { picking = nil }

    func newRoute() { replace(with: nil) }

    /// A suggested loop as the route, one undo step: from the Start through a Formpunkt every 5 km back to it, its
    /// sections routed already.
    func takeLoop(_ index: Int) {
        guard let found = loops?.found, found.indices.contains(index), let start = stops.first, let home = start.coord else { return }
        var route = [start], from = home
        for section in found[index].loop.sections.dropLast() {
            guard let end = section.coordinates.last else { continue }
            legs[Self.key(from, end)] = .routed(section)
            onRoad.insert(end)
            route.append(Stop(end, shape: true))
            from = end
        }
        // the Ziel on the Start, so the route is "Runde ab …"
        if let last = found[index].loop.sections.last { legs[Self.key(from, home)] = .routed(last) }
        route.append(Stop(home))
        change {
            stops = route
            return nil
        }
        frame()
    }

    var canUndo: Bool { !undos.isEmpty }
    var canRedo: Bool { !redos.isEmpty }

    func undo() {
        guard let previous = undos.popLast() else { return }
        redos.append(stops)
        restore(previous)
        edits += 1
        feel(.tap)
    }

    func redo() {
        guard let next = redos.popLast() else { return }
        undos.append(stops)
        restore(next)
        edits += 1
        feel(.tap)
    }

    /// Asks again for the legs that failed and the roads of the stops that found none.
    func retry() {
        legs = legs.filter { if case .failed = $0.value { false } else { true } }
        for id in Array(stopErrors.keys) { snap(id) }
        update()
    }

    /// `whole`: the whole route, also while a stretch of it is shown ("Ganze Route zeigen", `fitRoute`).
    func frame(whole: Bool = false) {
        framesWhole = whole
        framing += 1
    }

    /// `edit` changes the stops and returns the one it placed, whose road is then looked up.
    private func change(_ edit: () -> UUID?) {
        picking = nil
        closeLoops()
        let before = stops
        let placed = edit()
        guard stops != before else { return }
        undos.append(before)
        redos.removeAll()
        edits += 1
        if let placed { snap(placed) }
        update()
        feel(.tap)
    }

    private func feel(_ kind: Feedback.Kind) { feedback = Feedback(kind: kind, count: feedback.count + 1) }

    /// Brings back saved stops; those not known to lie on a road are looked up again, which also brings back or
    /// clears their errors.
    private func restore(_ saved: [Stop]) {
        picking = nil
        closeLoops()
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

    /// Farther than this from the nearest road, a point was not set on one.
    private static let offRoadMeters = 10.0

    private func snap(_ id: UUID) {
        guard let engine, let placed = stops.first(where: { $0.id == id }), let coord = placed.coord else { return }
        stopErrors[id] = nil
        guard !onRoad.contains(coord) else { return }
        snapping[id] = coord
        Task {
            let result: Result<[Double], Engine.Failure>
            do {
                var snapped = try await engine.leg([coord]).coordinates.first
                // a stop set on or beside a house, off the roads: its street, as when the house is found in the search,
                // not the path behind it
                if !placed.shape, let road = snapped, Geo.distance(coord, road) > Self.offRoadMeters,
                   let street = await engine.point(near: coord), let onStreet = try? await engine.leg([street]).coordinates.first {
                    snapped = onStreet
                }
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
                    } else if names[snapped] == nil && !stops[at].shape {
                        // beside the routing, which need not wait for it
                        Task {
                            guard let name = await engine.name(snapped) else { return }
                            names[snapped] = name
                            remember()
                        }
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
        defer { remember() }
        let needed = pairs
        let keys = Set(needed.map(\.key))
        for (key, request) in requests where !keys.contains(key) {
            request.cancel()
            requests[key] = nil
            legs[key] = nil
            progress[key] = nil
            batch.remove(key)
        }
        guard let engine else { return }
        for pair in needed where legs[pair.key] == nil {
            if !legs.values.contains(.routing) {
                batch = []
                batchStarted = .now
            }
            batch.insert(pair.key)
            legs[pair.key] = .routing
            let points = [pair.from.coord!, pair.to.coord!]
            requests[pair.key] = Task {
                let started = ContinuousClock.now
                let id = UUID().uuidString
                let following = Task {
                    while !Task.isCancelled {
                        try? await Task.sleep(for: .milliseconds(250))
                        if let value = await engine.progress(id), !Task.isCancelled { progress[pair.key] = value }
                    }
                }
                let state: LegState
                do { state = .routed(try await engine.leg(points, id: id)) } catch { state = .failed(Self.failure(error).message) }
                following.cancel()
                guard !Task.isCancelled else { return }
                progress[pair.key] = nil
                requests[pair.key] = nil
                legs[pair.key] = state
                remember()
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

    /// How far the legs being routed have come together, weighed by their beelines; nil in the first second, so a
    /// quick route shows no bar.
    var routingProgress: Double? {
        guard legs.values.contains(.routing), batchStarted.duration(to: .now) > .seconds(1) else { return nil }
        let parts = pairs.filter { batch.contains($0.key) }.map { pair in
            (Geo.distance(pair.from.coord!, pair.to.coord!), legs[pair.key] == .routing ? progress[pair.key] ?? 0 : 1)
        }
        let total = parts.reduce(0) { $0 + $1.0 }
        return total > 0 ? parts.reduce(0) { $0 + $1.0 * $1.1 } / total : nil
    }

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


    /// The first problem fixed elsewhere than at a stop's row: a Formpunkt without a road, or a leg that could not be
    /// routed.
    var problem: String? {
        if let shape = stops.first(where: { $0.shape && stopErrors[$0.id] != nil }) { return stopErrors[shape.id] }
        for pair in pairs { if case .failed(let message) = legs[pair.key] { return message } }
        return nil
    }

    /// The route's name as the planner gives it (`routeTitle`): "A → B" by its ends' places, "Runde ab A" where they
    /// are one; nil until both ends have one.
    var title: String? {
        guard let first = stops.first?.coord.flatMap({ names[$0] }), let last = stops.last?.coord.flatMap({ names[$0] }) else { return nil }
        return Self.place(first) == Self.place(last) ? "Runde ab \(Self.place(first))" : "\(Self.place(first)) → \(Self.place(last))"
    }

    /// A stop's place without its town: "Herrengasse 16" of "Herrengasse 16, 8010 Graz".
    static func place(_ name: String) -> String { name.split(separator: ",").first.map(String.init) ?? name }

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
            case .routed(let leg): lines += Self.lines(of: leg, at: index)
            case .failed: lines.append(.init(coordinates: [pair.from.coord!, pair.to.coord!], style: "air", leg: index))
            case .routing, nil:
                // the beeline fills in as the search comes on
                let (from, to) = (pair.from.coord!, pair.to.coord!)
                let done = progress[pair.key] ?? 0
                let reached = [from[0] + (to[0] - from[0]) * done, from[1] + (to[1] - from[1]) * done]
                if done > 0 { lines.append(.init(coordinates: [from, reached], style: "progress", leg: index)) }
                lines.append(.init(coordinates: [reached, to], style: "waiting", leg: index))
            }
        }
        let shown = waypoints
        // a round trip's Ziel lies under its Start: one marker
        let roundTrip = shown.count > 1 && shown[0].coord == shown[shown.count - 1].coord
        let pins = stops.compactMap { stop in
            roundTrip && stop.id == shown[shown.count - 1].id ? nil : stop.coord.map { coord in
                let badge = shown.firstIndex(of: stop).map { Self.badge(at: $0, of: shown.count) }
                return MapContent.Pin(stop: stop.id, coord: coord, badge: badge, error: stopErrors[stop.id] != nil)
            }
        }
        let stretch = current(section) ?? current(zoom)
        let suggested = (loops?.found ?? []).enumerated().map { index, found in
            MapContent.Loop(coordinates: found.loop.leg.coordinates, chosen: index == loops?.chosen, label: found.figures)
        }
        return MapContent(lines: lines, pins: pins, framing: framing, framesWhole: framesWhole, stretch: stretch?.line ?? [], focused: stretch?.pieces ?? [],
                          loops: suggested)
    }

    private func stretch(_ range: ClosedRange<Double>, parts: [[Int]], ends: [[Double]], legs chosenOn: [Leg]) -> Stretch {
        var pieces = parts.flatMap { part in
            chosenOn.indices.contains(part[0]) ? Self.lines(of: chosenOn[part[0]], at: part[0], within: part[1]...part[2]) : []
        }
        if ends.count == 2, !pieces.isEmpty {
            pieces[0].coordinates[0] = ends[0]
            pieces[pieces.count - 1].coordinates[pieces[pieces.count - 1].coordinates.count - 1] = ends[1]
        }
        var line: [[Double]] = []
        for piece in pieces { line += piece.coordinates.dropFirst(line.last == piece.coordinates.first ? 1 : 0) }
        // chosen on legs the route no longer has (the panel had not caught up), it is never the current one
        let route = routedLegs.compactMap { $0 } == chosenOn ? pairs.map(\.key) : []
        return Stretch(route: route, range: range, pieces: pieces, line: line)
    }

    /// A leg as the map draws it, by its surfaces; only its points `within`, when given.
    private static func lines(of leg: Leg, at index: Int, within: ClosedRange<Int> = 0...Int.max) -> [MapContent.Line] {
        leg.drawnSpans.compactMap { span in
            let (from, to) = (max(span.fromIndex, within.lowerBound), min(span.toIndex, within.upperBound))
            return from < to ? .init(coordinates: Array(leg.coordinates[from...to]), style: span.surface.rawValue, leg: index) : nil
        }
    }
}

/// A confirmation, one statement and at most one action, as the planner's snackbars.
struct Notice: Equatable, Identifiable {
    let id = UUID()
    let text: String
    var restore: RouteStore.Entry?
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
        var coordinates: [[Double]]
        let style: String
        let leg: Int
    }

    struct Pin: Equatable {
        let stop: UUID
        var coord: [Double]
        /// S, 1, 2 … Z; nil for a Formpunkt.
        let badge: String?
        let error: Bool
    }

    let lines: [Line]
    let pins: [Pin]
    let framing: Int
    var framesWhole = false
    /// The stretch the profile is zoomed into, which framing then shows alone.
    var stretch: [[Double]] = []
    /// The route along the stretch, which the light map shows over the rest of the route, faded.
    var focused: [Line] = []
    /// Loops suggested from the Start, which framing then shows.
    var loops: [Loop] = []

    struct Loop: Equatable {
        let coordinates: [[Double]]
        let chosen: Bool
        let label: String
    }
}
