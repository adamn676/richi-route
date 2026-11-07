import Foundation

/// The routing engine inside the app, asked as the planner asks the engine on the computer.
struct Engine: Sendable {
    struct Failure: Error { let message: String }

    let port: UInt16
    let profile: String
    /// The profile's parameters, as the planner sends them.
    let parameters: [String: String]
    /// The rules' revision and search coefficients a routed leg is kept with (`routingPolicyVersion`): a leg saved
    /// under another is routed again.
    let policy: String?

    /// Megabytes one search may take now: what iOS leaves the app, less what the search takes beside its paths (the
    /// routing data it reads) and a second, shorter search (long searches take turns). 450 MB measured on an iPhone
    /// 13 mini on 5 November 2026: long searches then peak about 1.9 GB of its 2.1 GB.
    static func searchMB() -> UInt32 { UInt32(max(Int(Memory.now().available >> 20) - 450, 512)) }

    /// Starts the engine with two searches at a time, as suits a phone's memory, away from the main thread:
    /// it reads the rules and the rider's files first.
    static func start() async -> Engine? {
        await Task.detached {
            guard let url = Bundle.main.url(forResource: "parameters", withExtension: "json", subdirectory: "Routing"),
                  let data = try? Data(contentsOf: url),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let profile = json["profile"] as? String,
                  let parameters = json["parameters"] as? [String: Any] else { return nil }
            let port = richi_engine_start(2, searchMB())
            return port == 0 ? nil : Engine(port: port, profile: profile, parameters: parameters.mapValues { "\($0)" }, policy: json["routingPolicy"] as? String)
        }.value
    }

    /// The route through `points` ([longitude, latitude]) as GeoJSON; `extra` adds request parameters,
    /// such as a round trip's.
    func route(_ points: [[Double]], extra: [URLQueryItem] = []) async throws -> Data {
        try await budget()
        return try await ask(routing("brouter", points, extra: extra))
    }

    /// The leg through `points` as the planner keeps it; a single point is asked as `[point, point]`, which
    /// the engine snaps to the nearest road. With an `id`, `progress(id)` tells how far its search has come.
    func leg(_ points: [[Double]], id: String? = nil) async throws -> Leg {
        try await budget()
        let followed = id.map { [URLQueryItem(name: "progress", value: $0)] } ?? []
        return try JSONDecoder().decode(Leg.self, from: try await ask(routing("leg", points.count == 1 ? points + points : points, extra: followed)))
    }

    /// How far the search for the leg asked with `id` has come, from 0 to 1; nil before it began and once it ended.
    func progress(_ id: String) async -> Double? {
        var url = URLComponents(string: "http://127.0.0.1:\(port)/progress")!
        url.queryItems = [URLQueryItem(name: "id", value: id)]
        return (try? await ask(URLRequest(url: url.url!))).flatMap { Double(String(decoding: $0, as: UTF8.self)) }
    }

    /// The search's budget from what the phone has free now, not at the start: maps and address indexes the rider
    /// opened since take their share.
    private func budget() async throws {
        _ = try await post("memory", Self.searchMB())
    }

    /// The planner's name for a point on a road ("Herrengasse 16, 8010 Graz"), nil where the areas know none.
    func name(_ coord: [Double]) async -> String? { await text("name", at: coord) }

    /// The town a point lies in or near, which names a loop after where it leads (`townAt`).
    func town(_ coord: [Double]) async -> String? { await text("town", at: coord) }

    /// The engine's `/name` or `/town` for a point: `{key: text or null}`.
    private func text(_ key: String, at coord: [Double]) async -> String? {
        var url = URLComponents(string: "http://127.0.0.1:\(port)/\(key)")!
        url.queryItems = [URLQueryItem(name: "lat", value: "\(coord[1])"), URLQueryItem(name: "lon", value: "\(coord[0])")]
        guard let data = try? await ask(URLRequest(url: url.url!)) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?[key] as? String
    }

    /// The planner's suggestions for a search, places near `near` first.
    func places(_ query: String, near: [Double]?) async throws -> [Place] {
        var url = URLComponents(string: "http://127.0.0.1:\(port)/places")!
        url.queryItems = [URLQueryItem(name: "q", value: query)]
            + (near.map { [URLQueryItem(name: "lat", value: "\($0[1])"), URLQueryItem(name: "lon", value: "\($0[0])")] } ?? [])
        return try JSONDecoder().decode([Place].self, from: try await ask(URLRequest(url: url.url!)))
    }

    /// Where an address at `near` meets its own `street`, nil where the street is not within 150 m; without a street,
    /// that of the house `near` is on or beside, nil away from houses.
    func point(on street: String? = nil, near: [Double]) async -> [Double]? {
        var url = URLComponents(string: "http://127.0.0.1:\(port)/street")!
        url.queryItems = [URLQueryItem(name: "lat", value: "\(near[1])"), URLQueryItem(name: "lon", value: "\(near[0])")]
            + (street.map { [URLQueryItem(name: "name", value: $0)] } ?? [])
        guard let data = try? await ask(URLRequest(url: url.url!)) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["point"] as? [Double]
    }

    /// A suggested loop as the engine's `/loops` gives it (`engine/planner/src/loops.rs`): its leg and the same in
    /// sections of about 5 km, its compass direction, the squares it passes for later searches to avoid, whether it
    /// rides out and back, and the points whose towns name it.
    struct Loop: Decodable, Equatable, Sendable {
        let leg: Leg
        let sections: [Leg]
        let heading: String
        let cells: [String]
        let back: Bool
        let along: [[Double]]
    }

    /// Three loops from `start` for a distance and climbing, avoiding the squares of loops suggested before there,
    /// each with its weight.
    func loops(from start: [Double], meters: Double, ascent: Double, earlier: [(cells: [String], weight: Double)]) async throws -> [Loop] {
        struct Body: Encodable {
            struct Target: Encodable { let meters: Double, ascent: Double }
            struct Earlier: Encodable { let cells: [String], weight: Double }
            let profile: String
            let parameters: [String: String]
            let start: [Double]
            let target: Target
            let random: [Double]
            let earlier: [Earlier]
        }
        try await budget()
        let body = Body(profile: profile, parameters: parameters, start: start, target: .init(meters: meters, ascent: ascent),
                        random: (0..<13).map { _ in Double.random(in: 0..<1) }, earlier: earlier.map { .init(cells: $0.cells, weight: $0.weight) })
        return try JSONDecoder().decode([Loop].self, from: try await post("loops", body))
    }

    /// The route's elevation profile from its legs, as the planner draws it, whole or the stretch `range`; nil without
    /// heights.
    func profile(_ legs: [Leg], range: ClosedRange<Double>? = nil) async throws -> Profile? {
        struct Body: Encodable {
            struct Part: Encodable {
                let coordinates: [[Double]]
                let elevations: [Double]?
                let distanceMeters: Double
            }
            let legs: [Part]
            let from: Double?
            let to: Double?
        }
        let body = Body(legs: legs.map {
            Body.Part(coordinates: $0.coordinates, elevations: $0.elevations, distanceMeters: $0.distanceMeters)
        }, from: range?.lowerBound, to: range?.upperBound)
        return try JSONDecoder().decode(Profile?.self, from: try await post("profile", body))
    }

    /// The route's surface sections and the metres of each group, as the planner lists them.
    func surfaces(_ legs: [Leg]) async throws -> Surfaces {
        struct Body: Encodable {
            struct Part: Encodable {
                let coordinates: [[Double]]
                let surfaces: [Leg.Span]
            }
            let legs: [Part]
        }
        let body = Body(legs: legs.map { Body.Part(coordinates: $0.coordinates, surfaces: $0.surfaces) })
        return try JSONDecoder().decode(Surfaces.self, from: try await post("surfaces", body))
    }

    private func post(_ path: String, _ body: some Encodable) async throws -> Data {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/\(path)")!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)
        // a long loop's search takes a while
        request.timeoutInterval = 150
        return try await ask(request)
    }

    private func routing(_ path: String, _ points: [[Double]], extra: [URLQueryItem] = []) -> URLRequest {
        var url = URLComponents(string: "http://127.0.0.1:\(port)/\(path)")!
        url.queryItems = [
            URLQueryItem(name: "profile", value: profile),
            URLQueryItem(name: "lonlats", value: points.map { "\($0[0]),\($0[1])" }.joined(separator: "|")),
            URLQueryItem(name: "format", value: "geojson"),
            URLQueryItem(name: "alternativeidx", value: "0"),
        ] + extra + parameters.sorted { $0.key < $1.key }.map { URLQueryItem(name: "profile:\($0.key)", value: $0.value) }
        var request = URLRequest(url: url.url!)
        request.timeoutInterval = 150
        return request
    }

    /// A track of [longitude, latitude, height where known] as FIT courses named `name`, in parts over 400 km, best cut
    /// at `stops` (indices into it): each part's name, as its file has it, and file.
    func fit(name: String, coordinates: [[Double]], stops: [Int] = []) async throws -> [(name: String, fit: Data)] {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/fit")!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["name": name, "coordinates": coordinates, "stops": stops] as [String: Any])
        let answer = try JSONSerialization.jsonObject(with: try await ask(request)) as? [String: Any]
        let parts = (answer?["parts"] as? [[String: String]] ?? []).compactMap { part in
            part["name"].flatMap { name in part["fit"].flatMap { Data(base64Encoded: $0) }.map { (name: name, fit: $0) } }
        }
        guard !parts.isEmpty else { throw Failure(message: "Keine FIT-Datei in der Antwort") }
        return parts
    }

    /// The track of a `route` answer: [longitude, latitude, height] per point.
    static func track(_ geojson: Data) -> [[Double]] {
        let json = try? JSONSerialization.jsonObject(with: geojson) as? [String: Any]
        let geometry = (json?["features"] as? [[String: Any]])?.first?["geometry"] as? [String: Any]
        return geometry?["coordinates"] as? [[Double]] ?? []
    }

    private func ask(_ request: URLRequest) async throws -> Data {
        var request = request
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let detail = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
            throw Failure(message: detail.isEmpty ? "HTTP \(status)" : detail)
        }
        return data
    }
}
