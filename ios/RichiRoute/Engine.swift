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
        var url = URLComponents(string: "http://127.0.0.1:\(port)/brouter")!
        url.queryItems = [
            URLQueryItem(name: "profile", value: profile),
            URLQueryItem(name: "lonlats", value: points.map { "\($0[0]),\($0[1])" }.joined(separator: "|")),
            URLQueryItem(name: "format", value: "geojson"),
            URLQueryItem(name: "alternativeidx", value: "0"),
        ] + extra + parameters
        var request = URLRequest(url: url.url!)
        request.timeoutInterval = 150
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let (data, response) = try await URLSession.shared.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            throw Failure(message: String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines))
        }
        return data
    }
}
