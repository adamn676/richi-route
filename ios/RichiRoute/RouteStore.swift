import Foundation

/// The routes on the phone, as the planner's files (`RouteFile`), in `DataFolder`'s `Routes`: the route being planned,
/// kept as it changes so the app opens with it again; the rider's saved routes; and the routes replaced without being
/// saved, the last three for seven days (`src/services/recent-routes.service.ts`). Lists come from a small index per
/// kind, so no route is read until it is opened; files are written in the background, one after another.
@MainActor
enum RouteStore {
    enum Kind: String, Codable, Sendable {
        case saved = "Saved"
        case recent = "Recent"
    }

    struct Entry: Identifiable, Equatable, Codable, Sendable {
        let id: UUID
        let kind: Kind
        var name: String
        var distanceMeters: Double
        var updated: Date
    }

    static let recentLimit = 3
    static let recentDays = 7

    private static let folder = DataFolder.root.appending(path: "Routes")
    private static let currentFile = folder.appending(path: "current.richiroute.json")
    /// Which saved route the current one is, if any, and on a second line "named" where its name is its own.
    private static let currentID = folder.appending(path: "current.id")
    private static let writing = DispatchQueue(label: "RouteStore", qos: .utility)
    private static var indexes: [Kind: [Entry]] = [:]

    // MARK: The route being planned

    static func current() -> (file: RouteFile, saved: UUID?, named: Bool)? {
        guard let file = read(currentFile) else { return nil }
        let lines = (try? String(contentsOf: currentID, encoding: .utf8))?.split(separator: "\n", omittingEmptySubsequences: false) ?? []
        return (file, lines.first.flatMap { UUID(uuidString: String($0)) }, lines.dropFirst().first == "named")
    }

    static func keep(_ file: RouteFile, saved: UUID?, named: Bool) {
        let (path, idPath) = (currentFile, currentID)
        writing.async {
            write(file, to: path)
            try? "\(saved?.uuidString ?? "")\n\(named ? "named" : "")".write(to: idPath, atomically: true, encoding: .utf8)
        }
    }

    // MARK: Saved and recent routes

    /// Newest first; recent routes beyond the limits leave the list.
    static func list(_ kind: Kind) -> [Entry] {
        var entries = index(kind).sorted { $0.updated > $1.updated }
        if kind == .recent {
            let oldest = Date.now.addingTimeInterval(-Double(recentDays) * 86_400)
            let gone = entries.enumerated().filter { $1.updated < oldest || $0 >= recentLimit }.map(\.element)
            gone.forEach(delete)
            entries.removeAll { gone.contains($0) }
        }
        return entries
    }

    static func file(_ entry: Entry) -> RouteFile? { read(url(entry.id, entry.kind)) }

    /// Writes a route as `kind` under `id`, a new one without, and returns its entry.
    @discardableResult
    static func store(_ file: RouteFile, as kind: Kind, id: UUID = UUID()) -> Entry {
        let entry = Entry(id: id, kind: kind, name: file.name, distanceMeters: file.distanceMeters, updated: .now)
        update(kind) { entries in
            entries.removeAll { $0.id == id }
            entries.append(entry)
        }
        let path = url(id, kind)
        writing.async { write(file, to: path) }
        return entry
    }

    static func delete(_ entry: Entry) {
        update(entry.kind) { $0.removeAll { $0.id == entry.id } }
        let path = url(entry.id, entry.kind)
        writing.async { try? FileManager.default.removeItem(at: path) }
    }

    private static func index(_ kind: Kind) -> [Entry] {
        if let entries = indexes[kind] { return entries }
        if let data = try? Data(contentsOf: indexURL(kind)), let entries = try? JSONDecoder().decode([Entry].self, from: data) {
            indexes[kind] = entries
            return entries
        }
        // routes saved before there was an index: read once
        let folder = indexURL(kind).deletingLastPathComponent()
        let urls = (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: [.contentModificationDateKey])) ?? []
        let found = urls.compactMap { url -> Entry? in
            guard let id = UUID(uuidString: url.deletingPathExtension().deletingPathExtension().lastPathComponent),
                  let file = read(url) else { return nil }
            let updated = (try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .now
            return Entry(id: id, kind: kind, name: file.name, distanceMeters: file.distanceMeters, updated: updated)
        }
        indexes[kind] = []
        update(kind) { $0 = found }
        return found
    }

    private static func update(_ kind: Kind, _ change: (inout [Entry]) -> Void) {
        var changed = index(kind)
        change(&changed)
        indexes[kind] = changed
        let (path, entries) = (indexURL(kind), changed)
        writing.async {
            try? FileManager.default.createDirectory(at: path.deletingLastPathComponent(), withIntermediateDirectories: true)
            try? JSONEncoder().encode(entries).write(to: path, options: .atomic)
        }
    }

    private static func indexURL(_ kind: Kind) -> URL { folder.appending(path: "\(kind.rawValue)/index.json") }

    private static func url(_ id: UUID, _ kind: Kind) -> URL {
        folder.appending(path: "\(kind.rawValue)/\(id.uuidString).richiroute.json")
    }

    private nonisolated static func read(_ url: URL) -> RouteFile? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(RouteFile.self, from: data)
    }

    private nonisolated static func write(_ file: RouteFile, to url: URL) {
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        guard let data = try? JSONEncoder().encode(file) else { return }
        try? data.write(to: url, options: .atomic)
    }
}
