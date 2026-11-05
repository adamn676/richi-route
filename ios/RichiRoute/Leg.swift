import Foundation

/// A routed leg as the engine's `/leg` answers it: the planner's `LegGeometry` (engine/planner/src/leg.rs).
struct Leg: Decodable, Sendable, Equatable {
    struct Span: Codable, Sendable, Equatable {
        /// What OSM says where the rider corrected the surface.
        struct Kind: Codable, Sendable, Equatable {
            let surface: Surface
            let surfaceTag: String?
        }

        let fromIndex: Int
        let toIndex: Int
        let surface: Surface
        let surfaceTag: String?
        var osm: Kind?
    }

    let coordinates: [[Double]]
    let elevations: [Double]?
    let distanceMeters: Double
    let ascentMeters: Double?
    let surfaces: [Span]

    /// The spans with what the engine's surfaces leave out drawn as unknown, as the planner draws them.
    var drawnSpans: [Span] {
        var spans: [Span] = []
        var at = 0
        for span in surfaces where span.toIndex > at {
            if span.fromIndex > at { spans.append(Span(fromIndex: at, toIndex: span.fromIndex, surface: .unknown, surfaceTag: nil, osm: nil)) }
            spans.append(span)
            at = span.toIndex
        }
        if at < coordinates.count - 1 { spans.append(Span(fromIndex: at, toIndex: coordinates.count - 1, surface: .unknown, surfaceTag: nil, osm: nil)) }
        return spans
    }
}

/// The road-bike groups of `src/domain/route-surfaces.ts`, in its order.
enum Surface: String, Codable, Sendable, CaseIterable {
    case paved, likelyPaved, rough, unpaved, unknown

    var label: String {
        switch self {
        case .paved: "Befestigt"
        case .likelyPaved: "Vermutlich befestigt"
        case .rough: "Kopfsteinpflaster/Holzbrücke"
        case .unpaved: "Unbefestigt"
        case .unknown: "Unbekannt"
        }
    }
}

enum Geo {
    /// The haversine distance in metres, as the planner's `distanceMeters`.
    static func distance(_ from: [Double], _ to: [Double]) -> Double {
        let radians = Double.pi / 180
        let lat1 = from[1] * radians, lat2 = to[1] * radians
        let halfLat = sin((lat2 - lat1) / 2), halfLon = sin((to[0] - from[0]) * radians / 2)
        let a = halfLat * halfLat + cos(lat1) * cos(lat2) * halfLon * halfLon
        return 2 * 6_371_008.8 * asin(min(a, 1).squareRoot())
    }

}
