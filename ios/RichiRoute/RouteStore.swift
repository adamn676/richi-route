import Foundation

/// The routes on the phone, as the planner's files (`RouteFile`), in `DataFolder`'s `Routes`: the route being planned,
/// kept as it changes, so the app opens with it again.
enum RouteStore {
    private static let folder = DataFolder.root.appending(path: "Routes")
    private static let currentFile = folder.appending(path: "current.richiroute.json")

    static func current() -> RouteFile? {
        guard let data = try? Data(contentsOf: currentFile) else { return nil }
        return try? JSONDecoder().decode(RouteFile.self, from: data)
    }

    static func keep(_ file: RouteFile) {
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        guard let data = try? JSONEncoder().encode(file) else { return }
        try? data.write(to: currentFile, options: .atomic)
    }
}
