import SwiftUI
import UIKit

/// The offline map (Map/style.json and, for Dark Mode, Map/style-dark.json, from scripts/build-ios-map.mjs) with a
/// pair of sources (map, relief) per area in the app's `Areas` folder (`DataFolder`), each layer once per area, and
/// the planner's route colours from its metadata.
struct MapStyle: Sendable {
    static let shared = MapStyle()

    private let light: String
    private let dark: String
    private let colors: [String: String]

    private init() {
        let ids = (try? FileManager.default.contentsOfDirectory(atPath: DataFolder.areas.path).sorted()) ?? []
        let light = Self.load("style", areas: ids)
        self.light = light.json
        dark = Self.load("style-dark", areas: ids).json
        colors = light.colors
    }

    /// The map for the light or the dark appearance.
    func json(dark: Bool) -> String { dark ? self.dark : light }

    private static func load(_ name: String, areas ids: [String]) -> (json: String, colors: [String: String]) {
        guard let url = Bundle.main.url(forResource: name, withExtension: "json", subdirectory: "Map"),
              let data = try? Data(contentsOf: url),
              var style = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let layers = style["layers"] as? [[String: Any]] else { return ("{}", [:]) }
        // the colours come with the app; the areas may not have been loaded yet
        let colors = (style["metadata"] as? [String: Any])?["richiroute:route"] as? [String: String] ?? [:]
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
        let json = (try? JSONSerialization.data(withJSONObject: style)).map { String(decoding: $0, as: UTF8.self) } ?? "{}"
        return (json, colors)
    }

    /// The planner's ink (`--accent`) and its colour for errors (`--danger`), as the map's markers have them in either
    /// mode; text and controls take `Color.ink` and `Color.danger`.
    static let ink = UIColor(red: 0x12 / 255, green: 0x18 / 255, blue: 0x16 / 255, alpha: 1)
    static let inkHex = "#121816"
    static let danger = UIColor(red: 0xa3 / 255, green: 0x26 / 255, blue: 0x1b / 255, alpha: 1)
    static let dangerHex = "#a3261b"
    /// The ink in Dark Mode, light enough to read on the dark map and panel.
    static let lightInkHex = "#e6ebe9"

    static func color(hex: String) -> UIColor {
        let rgb = Int(hex.dropFirst(), radix: 16) ?? 0x808080
        return UIColor(red: CGFloat(rgb >> 16 & 0xff) / 255, green: CGFloat(rgb >> 8 & 0xff) / 255, blue: CGFloat(rgb & 0xff) / 255, alpha: 1)
    }

    func color(_ surface: Surface) -> UIColor { color(surface.rawValue) }

    /// A route colour by its name in the metadata: a surface, `air` for a failed leg, `waiting` while it is routed.
    func color(_ name: String) -> UIColor { Self.color(hex: hex(name)) }

    /// The same as `#rrggbb`, for style expressions.
    func hex(_ name: String) -> String { colors[name] ?? "#808080" }
}

extension Color {
    /// The ink and the error colour for text and controls: the planner's own, and in Dark Mode light enough to read
    /// on the dark panel.
    static let ink = Color(UIColor { $0.userInterfaceStyle == .dark ? MapStyle.color(hex: MapStyle.lightInkHex) : MapStyle.ink })
    static let danger = Color(UIColor { $0.userInterfaceStyle == .dark ? UIColor(red: 0xff / 255, green: 0x8a / 255, blue: 0x7a / 255, alpha: 1) : MapStyle.danger })
}

/// Where the map and routing data lie: the app's own `Library/Application Support/RichiRoute`, which stays from one
/// install to the next. The engine finds its `segments` there by itself (`engine/ios/src/lib.rs`, from `HOME`):
/// the two must name the same folder.
enum DataFolder {
    static let root = URL.applicationSupportDirectory.appending(path: "RichiRoute")
    static let areas = root.appending(path: "Areas")
}
