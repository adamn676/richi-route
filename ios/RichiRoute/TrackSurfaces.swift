import Foundation

/// The surfaces of a recorded track, as the planner finds them (`src/domain/gpx-surfaces.ts`): the track is routed in
/// portions of about 2 km through a point every 100 m, and a route that is the same way lends the track its surfaces.
/// Denser points snap onto sidewalks and side streets; a portion that does not match is split and routed again.
enum TrackSurfaces {
    private struct Portion {
        let segment: Int
        let from: Int
        let to: Int
        let points: [[Double]]
    }

    private static let portionMeters = 2000.0, anchorMeters = 100.0, minPortionMeters = 150.0
    /// How far apart track and route may be and still be the same way.
    private static let tolerance = 8.0

    /// Each segment's surfaces, one portion at a time, so editing keeps the engine's other search; `progress` gets the
    /// share of the track checked. nil when cancelled; a failing engine ends the search, with what it found so far.
    static func find(_ track: Track, engine: Engine, progress: @Sendable (Double) async -> Void) async -> [[Leg.Span]]? {
        var queue = portions(track)
        let length = { (portion: Portion) in
            track.segments[portion.segment].distances[portion.to] - track.segments[portion.segment].distances[portion.from]
        }
        let total = queue.reduce(0) { $0 + length($1) }
        var checked = 0.0
        var surfaces = Array(repeating: [Leg.Span](), count: track.segments.count)
        await progress(0)
        while !queue.isEmpty {
            let portion = queue.removeFirst()
            guard let candidate = try? await engine.leg(portion.points), !Task.isCancelled else { break }
            let spans = match(track, portion, candidate)
            let halves = spans == nil ? split(track, portion) : []
            if halves.isEmpty {
                surfaces[portion.segment] += spans ?? []
                checked += length(portion)
                await progress(total > 0 ? checked / total : 1)
            } else {
                queue.insert(contentsOf: halves, at: 0)
            }
        }
        return Task.isCancelled ? nil : surfaces
    }

    private static func portion(_ track: Track, _ segment: Int, _ from: Int, _ to: Int) -> Portion {
        let coordinates = track.segments[segment].coordinates, distances = track.segments[segment].distances
        var points = [coordinates[from]], anchor = from
        for i in stride(from: from + 1, to: to, by: 1) where distances[i] - distances[anchor] >= anchorMeters {
            points.append(coordinates[i])
            anchor = i
        }
        points.append(coordinates[to])
        return Portion(segment: segment, from: from, to: to, points: points)
    }

    private static func portions(_ track: Track) -> [Portion] {
        var portions: [Portion] = []
        for (s, segment) in track.segments.enumerated() {
            let distances = segment.distances
            var from = 0
            func finish(_ to: Int) {
                if to > from && distances[to] > distances[from] { portions.append(portion(track, s, from, to)) }
            }
            for i in segment.coordinates.indices.dropFirst() {
                // long straight chords tell too little of the road taken
                if distances[i] - distances[i - 1] > 200 {
                    finish(i - 1)
                    from = i
                } else if distances[i] - distances[from] >= portionMeters {
                    finish(i)
                    from = i
                }
            }
            finish(segment.coordinates.count - 1)
        }
        return portions
    }

    /// The two halves of a portion that did not match, or none once it is short.
    private static func split(_ track: Track, _ portion: Portion) -> [Portion] {
        let distances = track.segments[portion.segment].distances, (from, to) = (portion.from, portion.to)
        guard to - from >= 2, distances[to] - distances[from] > minPortionMeters else { return [] }
        var middle = from + 1
        while middle < to - 1 && distances[middle] - distances[from] < (distances[to] - distances[from]) / 2 { middle += 1 }
        return [Self.portion(track, portion.segment, from, middle), Self.portion(track, portion.segment, middle, to)]
    }

    /// Points every 5 m in local metres, each with its place along the line (vertex index plus fraction), and the sample
    /// at each vertex.
    private struct Samples {
        var x: [Double] = [], y: [Double] = [], at: [Double] = []
        var vertices = [0]

        init(_ coordinates: [[Double]], from origin: [Double]) {
            let kx = 111_320 * cos(origin[1] * .pi / 180), ky = 110_540.0
            let xy = coordinates.map { [(($0[0] - origin[0] + 540).truncatingRemainder(dividingBy: 360) - 180) * kx, ($0[1] - origin[1]) * ky] }
            (x, y, at) = ([xy[0][0]], [xy[0][1]], [0])
            for k in xy.indices.dropFirst() {
                let (a, b) = (xy[k - 1], xy[k])
                let steps = max(1, Int((hypot(b[0] - a[0], b[1] - a[1]) / 5).rounded(.up)))
                for t in 1...steps {
                    let f = Double(t) / Double(steps)
                    x.append(a[0] + (b[0] - a[0]) * f)
                    y.append(a[1] + (b[1] - a[1]) * f)
                    at.append(Double(k - 1) + f)
                }
                vertices.append(x.count - 1)
            }
        }
    }

    /// The first of the largest, as the planner picks it.
    private static func largest<Key>(_ weights: [(Key, Double)]) -> Key {
        weights.dropFirst().reduce(weights[0]) { $1.1 > $0.1 ? $1 : $0 }.0
    }

    private static func add<Key: Equatable>(_ key: Key, _ metres: Double, to weights: inout [(Key, Double)]) {
        if let at = weights.firstIndex(where: { $0.0 == key }) { weights[at].1 += metres } else { weights.append((key, metres)) }
    }

    /// The track's surfaces from a portion routed, nil where the route is not the same way: both are walked in travel
    /// order and must stay within `tolerance` metres (a discrete Fréchet distance), so a parallel road, a detour, a
    /// reversed path or a missing return leg lends nothing. Small length differences and GPS jitter do not matter.
    private static func match(_ track: Track, _ portion: Portion, _ candidate: Leg) -> [Leg.Span]? {
        let original = Array(track.segments[portion.segment].coordinates[portion.from...portion.to])
        guard !candidate.coordinates.isEmpty else { return nil }
        let a = Samples(original, from: original[0]), b = Samples(candidate.coordinates, from: original[0])
        let (n, m) = (a.x.count, b.x.count)
        guard n * m <= 4_000_000 else { return nil }
        var reach = [Bool](repeating: false, count: n * m)
        for i in 0..<n {
            var reachedRow = false
            for j in 0..<m {
                // reachability first: most cells far from the diagonal never need a distance
                let reached = (i == 0 && j == 0) || (i > 0 && reach[(i - 1) * m + j]) || (j > 0 && reach[i * m + j - 1])
                    || (i > 0 && j > 0 && reach[(i - 1) * m + j - 1])
                if reached && hypot(a.x[i] - b.x[j], a.y[i] - b.y[j]) <= tolerance {
                    reach[i * m + j] = true
                    reachedRow = true
                }
            }
            // a row that reaches nothing cuts every later one off
            guard reachedRow else { return nil }
        }
        guard reach[n * m - 1] else { return nil }
        // walking back gives, for each track point, the first and last routed points it pairs with
        var first = [Int](repeating: m, count: n), last = [Int](repeating: -1, count: n)
        var (i, j) = (n - 1, m - 1)
        while true {
            first[i] = min(first[i], j)
            last[i] = max(last[i], j)
            if i == 0 && j == 0 { break }
            if i > 0 && j > 0 && reach[(i - 1) * m + j - 1] {
                i -= 1
                j -= 1
            } else if i > 0 && reach[(i - 1) * m + j] {
                i -= 1
            } else {
                j -= 1
            }
        }

        // the routed leg's span at each of its steps, -1 where it has none
        var spanOf = [Int](repeating: -1, count: max(candidate.coordinates.count - 1, 0))
        for (index, span) in candidate.surfaces.enumerated() {
            for k in stride(from: span.fromIndex, to: span.toIndex, by: 1) where spanOf.indices.contains(k) { spanOf[k] = index }
        }
        var spans: [Leg.Span] = []
        for v in original.indices.dropFirst() {
            // The routed stretch paired with this track step, in metres per span. The step takes the surface covering
            // most of it, with the tag of that surface's largest part: a junction, the next way of the same road or a
            // few metres tagged otherwise within a long step leave no gap.
            let (from, to) = (last[a.vertices[v - 1]], first[a.vertices[v]])
            var shares: [(Int, Double)] = []
            func share(_ j: Int, _ k: Int) {
                let step = min(Int(((b.at[j] + b.at[k]) / 2).rounded(.down)), candidate.coordinates.count - 2)
                add(spanOf.indices.contains(step) ? spanOf[step] : -1, hypot(b.x[k] - b.x[j], b.y[k] - b.y[j]), to: &shares)
            }
            if from == to { share(from, from) }
            for j in min(from, to)..<max(from, to) { share(j, j + 1) }
            var bySurface: [(Surface, Double)] = []
            for (span, metres) in shares { add(span >= 0 ? candidate.surfaces[span].surface : .unknown, metres, to: &bySurface) }
            let surface = largest(bySurface)
            guard surface != .unknown else { continue }
            let span = candidate.surfaces[largest(shares.filter { $0.0 >= 0 && candidate.surfaces[$0.0].surface == surface })]
            let (fromIndex, toIndex) = (portion.from + v - 1, portion.from + v)
            if let previous = spans.last, previous.toIndex == fromIndex, previous.surface == span.surface,
               previous.surfaceTag == span.surfaceTag, previous.osm == span.osm {
                spans[spans.count - 1].toIndex = toIndex
            } else {
                spans.append(Leg.Span(fromIndex: fromIndex, toIndex: toIndex, surface: span.surface, surfaceTag: span.surfaceTag, osm: span.osm))
            }
        }
        return spans
    }
}
