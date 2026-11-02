import UIKit

/// The offline map (Map/style.json, from scripts/build-ios-map.mjs) with a pair of sources (map, relief) per
/// area in the app's `Areas` folder (`DataFolder`), each layer once per area, and the planner's route colours
/// from its metadata.
struct MapStyle: Sendable {
    static let shared = MapStyle()

    let json: String
    private let colors: [String: String]

    private init() {
        guard let url = Bundle.main.url(forResource: "style", withExtension: "json", subdirectory: "Map"),
              let data = try? Data(contentsOf: url),
              var style = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let layers = style["layers"] as? [[String: Any]] else {
            json = "{}"
            colors = [:]
            return
        }
        // the colours come with the app; the areas may not have been loaded yet
        colors = (style["metadata"] as? [String: Any])?["richiroute:route"] as? [String: String] ?? [:]
        let ids = (try? FileManager.default.contentsOfDirectory(atPath: DataFolder.areas.path).sorted()) ?? []
        var sources: [String: Any] = [:]
        for (name, source) in style["sources"] as? [String: [String: Any]] ?? [:] {
            for id in ids {
                let file = DataFolder.areas.appending(path: "\(id)/\(name).pmtiles")
                sources["\(name)-\(id)"] = source.merging(["url": "pmtiles://\(file.absoluteString)"]) { $1 }
            }
        }
        style["sources"] = sources
        style["layers"] = layers.flatMap { layer -> [[String: Any]] in
            guard let source = layer["source"] as? String else { return [layer] }
            return ids.map { id in layer.merging(["id": "\(layer["id"] ?? "")-\(id)", "source": "\(source)-\(id)"]) { $1 } }
        }
        json = (try? JSONSerialization.data(withJSONObject: style)).map { String(decoding: $0, as: UTF8.self) } ?? "{}"
    }

    /// The planner's ink (`--accent`) and its colour for errors (`--danger`), for markers and the panel alike.
    static let ink = UIColor(red: 0x12 / 255, green: 0x18 / 255, blue: 0x16 / 255, alpha: 1)
    static let inkHex = "#121816"
    static let danger = UIColor(red: 0xa3 / 255, green: 0x26 / 255, blue: 0x1b / 255, alpha: 1)
    static let dangerHex = "#a3261b"

    func color(_ surface: Surface) -> UIColor { color(surface.rawValue) }

    /// A route colour by its name in the metadata: a surface, `air` for a failed leg, `waiting` while it is routed.
    func color(_ name: String) -> UIColor {
        let rgb = Int(hex(name).dropFirst(), radix: 16) ?? 0x808080
        return UIColor(red: CGFloat(rgb >> 16 & 0xff) / 255, green: CGFloat(rgb >> 8 & 0xff) / 255, blue: CGFloat(rgb & 0xff) / 255, alpha: 1)
    }

    /// The same as `#rrggbb`, for style expressions.
    func hex(_ name: String) -> String { colors[name] ?? "#808080" }
}

/// Where the map and routing data lie: the app's own `Library/Application Support/RichiRoute`, which stays from one
/// install to the next. The engine finds its `segments` there by itself (`engine/ios/src/lib.rs`, from `HOME`):
/// the two must name the same folder.
enum DataFolder {
    static let root = URL.applicationSupportDirectory.appending(path: "RichiRoute")
    static let areas = root.appending(path: "Areas")
}
