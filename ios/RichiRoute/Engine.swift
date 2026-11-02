import Foundation

/// The routing engine inside the app, asked as the planner asks the engine on the computer.
struct Engine: Sendable {
    struct Failure: Error { let message: String }

    let port: UInt16
    let profile: String
    let parameters: [URLQueryItem]
    /// Megabytes one search may take: what iOS leaves the app, less the rest of the app and a second,
    /// shorter search (long searches take turns).
    let searchMB: UInt32

    /// Starts the engine with two searches at a time, as suits a phone's memory, away from the main thread:
    /// it reads the rules and the rider's files first.
    static func start() async -> Engine? {
        await Task.detached {
            guard let url = Bundle.main.url(forResource: "parameters", withExtension: "json", subdirectory: "Routing"),
                  let data = try? Data(contentsOf: url),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let profile = json["profile"] as? String,
                  let parameters = json["parameters"] as? [String: Any] else { return nil }
            let searchMB = UInt32(max(Int(Memory.now().available >> 20) - 768, 512))
            let port = richi_engine_start(2, searchMB)
            return port == 0 ? nil : Engine(port: port, profile: profile, parameters: parameters.sorted { $0.key < $1.key }
                .map { URLQueryItem(name: "profile:\($0.key)", value: "\($0.value)") }, searchMB: searchMB)
        }.value
    }

    /// The route through `points` ([longitude, latitude]) as GeoJSON; `extra` adds request parameters,
    /// such as a round trip's.
    func route(_ points: [[Double]], extra: [URLQueryItem] = []) async throws -> Data {
        try await ask(routing("brouter", points, extra: extra))
    }

    /// The leg through `points` as the planner keeps it; a single point is asked as `[point, point]`, which
    /// the engine snaps to the nearest road.
    func leg(_ points: [[Double]]) async throws -> Leg {
        try JSONDecoder().decode(Leg.self, from: try await ask(routing("leg", points.count == 1 ? points + points : points)))
    }

    /// The planner's name for a point on a road ("Herrengasse 16, 8010 Graz"), nil where the areas know none.
    func name(_ coord: [Double]) async -> String? {
        var url = URLComponents(string: "http://127.0.0.1:\(port)/name")!
        url.queryItems = [URLQueryItem(name: "lat", value: "\(coord[1])"), URLQueryItem(name: "lon", value: "\(coord[0])")]
        guard let data = try? await ask(URLRequest(url: url.url!)) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["name"] as? String
    }

    private func routing(_ path: String, _ points: [[Double]], extra: [URLQueryItem] = []) -> URLRequest {
        var url = URLComponents(string: "http://127.0.0.1:\(port)/\(path)")!
        url.queryItems = [
            URLQueryItem(name: "profile", value: profile),
            URLQueryItem(name: "lonlats", value: points.map { "\($0[0]),\($0[1])" }.joined(separator: "|")),
            URLQueryItem(name: "format", value: "geojson"),
            URLQueryItem(name: "alternativeidx", value: "0"),
        ] + extra + parameters
        var request = URLRequest(url: url.url!)
        request.timeoutInterval = 150
        return request
    }

    /// The route of a `route` answer as FIT courses named `name`, in parts over 400 km: each part's name, as its
    /// file has it, and file.
    func fit(name: String, route geojson: Data) async throws -> [(name: String, fit: Data)] {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/fit")!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["name": name, "coordinates": Self.track(geojson)])
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
        guard status == 200 else {
            let detail = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
            throw Failure(message: detail.isEmpty ? "HTTP \(status)" : detail)
        }
        return data
    }
}
