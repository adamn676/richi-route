import Foundation

/// The planner's notices on stretches the rules know a catch on (`src/domain/local-routing-notices.ts`), such as stairs
/// with a ramp to push up, from the rules file the planner reads (`Routing/notices.json`).
enum RouteNotices {
    private struct Rules: Decodable { let notices: [Notice] }

    struct Notice: Decodable, Identifiable, Sendable {
        let id: String
        let text: String
        /// "forward" where it holds only along the stretch's direction, else "both".
        let direction: String
        let segments: [[[Double]]]
    }

    private static let notices: [Notice] = {
        guard let url = Bundle.main.url(forResource: "notices", withExtension: "json", subdirectory: "Routing"),
              let data = try? Data(contentsOf: url) else { return [] }
        return (try? JSONDecoder().decode(Rules.self, from: data))?.notices ?? []
    }()

    /// The notices whose stretches the legs pass, in the rules' order.
    static func along(_ legs: [Leg]) -> [Notice] {
        notices.filter { notice in
            notice.segments.contains { segment in legs.contains { passes($0.coordinates, segment, forward: notice.direction == "forward") } }
        }
    }

    /// Whether a step of the line lies on the stretch from `segment[0]` to `segment[1]`: each of its ends no more than
    /// 2 cm out of the way between them.
    private static func passes(_ line: [[Double]], _ segment: [[Double]], forward: Bool) -> Bool {
        let (start, end) = (segment[0], segment[1])
        let length = Geo.distance(start, end), margin = 1e-6
        let (west, east) = (min(start[0], end[0]) - margin, max(start[0], end[0]) + margin)
        let (south, north) = (min(start[1], end[1]) - margin, max(start[1], end[1]) + margin)
        let on = { (point: [Double]) in Geo.distance(start, point) + Geo.distance(point, end) < length + 0.02 }
        return zip(line, line.dropFirst()).contains { a, b in
            // a step wholly beside the stretch's box is passed over, as the planner's index does
            guard !(a[0] < west && b[0] < west || a[0] > east && b[0] > east || a[1] < south && b[1] < south || a[1] > north && b[1] > north),
                  Geo.distance(a, b) >= 0.1 else { return false }
            if forward && (b[0] - a[0]) * (end[0] - start[0]) + (b[1] - a[1]) * (end[1] - start[1]) <= 0 { return false }
            return on(a) && on(b)
        }
    }
}
