import Foundation

/// A route as the planner saves it, its "RichiRoute-Datei" (`exportRouteBackup`, `src/domain/saved-route.ts`):
/// `{format: "richiroute", version: 1, name, draft}`, the draft as `parseDraft` reads it (`src/domain/route-draft.ts`),
/// so the web planner and the app open each other's routes.
struct RouteFile: Codable, Sendable {
    var format = "richiroute"
    var version = 1
    var name: String
    var draft: Draft

    struct Draft: Codable, Sendable {
        var version = 1
        var points: [Point]
        var legs: [String: SavedLeg]
    }

    struct Point: Codable, Sendable {
        let id: String
        let type: String
        let kind: String?
        let coord: [Double]?
        let address: String?
        let userInput: String?
        var isGeocoding: Bool?
    }

    struct SavedLeg: Codable, Sendable {
        let id: String
        let fromId: String
        let toId: String
        let fromCoord: [Double]
        let toCoord: [Double]
        let coordinates: [[Double]]
        let elevations: [Double]?
        let surfaces: [Leg.Span]
        let distanceMeters: Double
        let ascentMeters: Double?
        let status: String
        let routingPolicy: String?

        /// Encodes `null` for missing heights and climbing, as the planner writes them.
        func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(id, forKey: .id)
            try container.encode(fromId, forKey: .fromId)
            try container.encode(toId, forKey: .toId)
            try container.encode(fromCoord, forKey: .fromCoord)
            try container.encode(toCoord, forKey: .toCoord)
            try container.encode(coordinates, forKey: .coordinates)
            try container.encode(elevations, forKey: .elevations)
            try container.encode(surfaces, forKey: .surfaces)
            try container.encode(distanceMeters, forKey: .distanceMeters)
            try container.encode(ascentMeters, forKey: .ascentMeters)
            try container.encode(status, forKey: .status)
            try container.encodeIfPresent(routingPolicy, forKey: .routingPolicy)
        }
    }

    /// A stop's or Formpunkt's id as the planner writes it.
    static func pointID(_ stop: Planner.Stop) -> String { "\(stop.shape ? "shape" : "stop")-\(stop.id.uuidString.lowercased())" }

    var distanceMeters: Double { draft.legs.values.reduce(0) { $0 + $1.distanceMeters } }
}

extension RouteFile.Point {
    /// Encodes `null` for a stop not yet placed and without an address, as the planner writes them.
    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(type, forKey: .type)
        try container.encodeIfPresent(kind, forKey: .kind)
        try container.encode(coord, forKey: .coord)
        if type == "stop" {
            try container.encode(address, forKey: .address)
            try container.encode(userInput ?? "", forKey: .userInput)
            try container.encode(false, forKey: .isGeocoding)
        }
    }
}
