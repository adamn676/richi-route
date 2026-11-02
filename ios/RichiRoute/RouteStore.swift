import Foundation

/// The routes on the phone, as the planner's files (`RouteFile`), in `DataFolder`'s `Routes`: the route being planned,
/// kept as it changes so the app opens with it again; the rider's saved routes; and the routes replaced without being
/// saved, the last three for seven days (`src/services/recent-routes.service.ts`).
enum RouteStore {
    enum Kind: String {
        case saved = "Saved"
        case recent = "Recent"
    }

    struct Entry: Identifiable, Equatable {
        let id: UUID
        let kind: Kind
        let name: String
        let distanceMeters: Double
        let updated: Date
    }

    static let recentLimit = 3
    static let recentDays = 7

    private static let folder = DataFolder.root.appending(path: "Routes")
    private static let currentFile = folder.appending(path: "current.richiroute.json")
    /// Which saved route the current one is, if any.
    private static let currentID = folder.appending(path: "current.id")

    // MARK: The route being planned

    static func current() -> (file: RouteFile, saved: UUID?)? {
        guard let file = read(currentFile) else { return nil }
        let id = (try? String(contentsOf: currentID, encoding: .utf8)).flatMap(UUID.init(uuidString:))
        return (file, id)
    }

    static func keep(_ file: RouteFile, saved: UUID?) {
        write(file, to: currentFile)
        try? (saved?.uuidString ?? "").write(to: currentID, atomically: true, encoding: .utf8)
    }

    // MARK: Saved and recent routes

    static func list(_ kind: Kind) -> [Entry] {
        let directory = folder.appending(path: kind.rawValue)
        let urls = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.contentModificationDateKey])) ?? []
        let entries = urls.compactMap { url -> Entry? in
            guard let id = UUID(uuidString: url.deletingPathExtension().deletingPathExtension().lastPathComponent),
                  let file = read(url) else { return nil }
            let updated = (try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
            return Entry(id: id, kind: kind, name: file.name, distanceMeters: file.distanceMeters, updated: updated)
        }
        let sorted = entries.sorted { $0.updated > $1.updated }
        guard kind == .recent else { return sorted }
        let oldest = Date.now.addingTimeInterval(-Double(recentDays) * 86_400)
        let kept = sorted.filter { $0.updated >= oldest }.prefix(recentLimit)
        for entry in sorted where !kept.contains(entry) { delete(entry) }
        return Array(kept)
    }

    static func file(_ entry: Entry) -> RouteFile? { read(url(entry.id, entry.kind)) }

    /// Writes a route as `kind` under `id`, a new one without.
    @discardableResult
    static func store(_ file: RouteFile, as kind: Kind, id: UUID = UUID()) -> UUID {
        write(file, to: url(id, kind))
        return id
    }

    static func delete(_ entry: Entry) {
        try? FileManager.default.removeItem(at: url(entry.id, entry.kind))
    }

    private static func url(_ id: UUID, _ kind: Kind) -> URL {
        folder.appending(path: "\(kind.rawValue)/\(id.uuidString).richiroute.json")
    }

    private static func read(_ url: URL) -> RouteFile? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(RouteFile.self, from: data)
    }

    private static func write(_ file: RouteFile, to url: URL) {
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        guard let data = try? JSONEncoder().encode(file) else { return }
        try? data.write(to: url, options: .atomic)
    }
}
