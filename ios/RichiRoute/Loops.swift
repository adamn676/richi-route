import Foundation

/// Loops suggested from the Start (the planner's "Runden vorschlagen"): a distance and climbing, the three loops the
/// engine finds for them, and the one chosen on the map.
struct Loops: Equatable {
    enum Result: Equatable {
        case searching
        case found([Found])
        case failed(String)
    }

    struct Found: Equatable {
        let loop: Engine.Loop
        let name: String
        /// Its surfaces and profile, to judge it by before riding it; there shortly after the loops.
        var surfaces: Surfaces?
        var profile: Profile?

        /// Its distance and climbing, as the list and the map give them.
        var figures: String { "\(Format.km(loop.leg.distanceMeters, digits: 0)) km · \(Format.whole(loop.leg.ascentMeters ?? 0)) hm" }
    }

    /// The planner's slider steps: finer where most rides lie.
    static let kilometreSteps = steps([(10, 100, 5), (110, 300, 10), (325, 600, 25), (650, 1000, 50)])
    static let ascentSteps = steps([(0, 1000, 50), (1100, 3000, 100), (3250, 6000, 250), (6500, 10000, 500), (11000, 15000, 1000)])

    private static func steps(_ runs: [(Int, Int, Int)]) -> [Int] { runs.flatMap { Array(stride(from: $0.0, through: $0.1, by: $0.2)) } }

    var kilometres = 80
    var ascent = 800
    /// Whether the distance and climbing are open to change, rather than folded into one line above the loops.
    var editing = true
    var result: Result?
    var chosen = 0

    var found: [Found] { if case .found(let found) = result { found } else { [] } }
}

extension Planner {
    /// Opens the choice of a distance and climbing, nothing suggested yet.
    func openLoops() { loops = Loops() }

    /// Suggests loops from the Start for the distance and climbing set; a search under way gives way to the next.
    func suggestLoops() {
        guard let start = stops.first?.coord, let engine, var next = loops else { return }
        (next.result, next.chosen, next.editing) = (.searching, 0, false)
        loops = next
        loopSearch?.cancel()
        loopSearch = Task {
            do {
                let place = LoopHistory.place(start)
                let found = try await engine.loops(from: start, meters: Double(next.kilometres) * 1000, ascent: Double(next.ascent),
                                                   earlier: LoopHistory.earlier(at: place))
                let named = await Self.named(found, from: start, engine: engine)
                guard !Task.isCancelled else { return }
                LoopHistory.add(found.map(\.cells), at: place)
                loops?.result = .found(named)
                frame()
                await details(of: named, engine: engine)
            } catch {
                guard !Task.isCancelled else { return }
                loops?.result = .failed((error as? Engine.Failure)?.message ?? "Runden konnten nicht berechnet werden.")
            }
        }
    }

    /// The loops' surfaces and profiles, one loop after the other from the first, which is shown first; a new search
    /// stops it, so the engine is free for that.
    private func details(of found: [Loops.Found], engine: Engine) async {
        for (index, leg) in found.map(\.loop.leg).enumerated() {
            async let surfaces = engine.surfaces([leg])
            async let profile = engine.profile([leg])
            let (s, p) = (try? await surfaces, try? await profile)
            guard !Task.isCancelled, case .found(var list)? = loops?.result, list.indices.contains(index) else { return }
            (list[index].surfaces, list[index].profile) = (s, p)
            loops?.result = .found(list)
        }
    }

    func chooseLoop(_ index: Int) { loops?.chosen = index }

    func closeLoops() {
        loopSearch?.cancel()
        loops = nil
    }

    /// The planner's names (`suggestLoops`): a loop after the town it passes most, a ride out and back after the town it
    /// turns in, other than the start's own and those naming another; without one, its compass direction.
    private static func named(_ loops: [Engine.Loop], from start: [Double], engine: Engine) async -> [Loops.Found] {
        // every town at once: the start's, then each loop's along it
        let points = [start] + loops.flatMap(\.along)
        let towns = await withTaskGroup(of: (Int, String?).self) { group in
            for (index, point) in points.enumerated() { group.addTask { (index, await engine.town(point)) } }
            var towns = [String?](repeating: nil, count: points.count)
            for await (index, town) in group { towns[index] = town }
            return towns
        }
        var used: Set<String?> = [towns[0]], next = 1
        return loops.map { loop in
            let names = towns[next..<next + loop.along.count].compactMap { $0 }.filter { !used.contains($0) }
            next += loop.along.count
            // the most named, the first of equals
            let place = names.max { a, b in names.count { $0 == a } < names.count { $0 == b } }
            used.insert(place)
            return Loops.Found(loop: loop, name: place.map { loop.back ? "Nach \($0)" : "Über \($0)" } ?? "Nach \(loop.heading)")
        }
    }
}

/// The squares of the loops suggested lately from each place, newest search first, so that each search brings other
/// loops: within about 1 km is the same place, its last four searches weigh less the older they are, and the ten
/// places used last are kept (the planner's `richiroute.loop-history`).
enum LoopHistory {
    private struct Place: Codable {
        let place: String
        let searches: [[[String]]]
    }

    private static let key = "loopHistory", recency = [1, 0.75, 0.5, 0.3]

    static func place(_ start: [Double]) -> String { start.map { String(format: "%.2f", $0) }.joined(separator: ",") }

    static func earlier(at place: String) -> [(cells: [String], weight: Double)] {
        let searches = places().first { $0.place == place }?.searches ?? []
        return searches.enumerated().flatMap { index, loops in loops.map { (cells: $0, weight: recency[index]) } }
    }

    static func add(_ loops: [[String]], at place: String) {
        var places = places()
        let searches = [loops] + (places.first { $0.place == place }?.searches ?? [])
        places.removeAll { $0.place == place }
        places.append(Place(place: place, searches: Array(searches.prefix(recency.count))))
        UserDefaults.standard.set(try? JSONEncoder().encode(Array(places.suffix(10))), forKey: key)
    }

    private static func places() -> [Place] {
        UserDefaults.standard.data(forKey: key).flatMap { try? JSONDecoder().decode([Place].self, from: $0) } ?? []
    }
}
