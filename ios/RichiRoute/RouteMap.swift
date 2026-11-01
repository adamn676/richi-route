import MapLibre
import SwiftUI

/// The offline map (Map/style.json, from scripts/build-ios-map.mjs) over the bundled areas, with a route
/// drawn on top in the planner's colours and fitted into view.
struct RouteMap: UIViewRepresentable {
    let route: Data?

    func makeUIView(context: Context) -> MLNMapView {
        let map = MLNMapView(frame: .zero)
        map.delegate = context.coordinator
        map.styleJSON = context.coordinator.style
        map.setCenter(CLLocationCoordinate2D(latitude: 47.3, longitude: 13.5), zoomLevel: 6, animated: false)
        return map
    }

    func updateUIView(_ map: MLNMapView, context: Context) {
        context.coordinator.show(route, on: map)
    }

    func makeCoordinator() -> Coordinator {
        let style = Self.style()
        return Coordinator(style: style?.json ?? "{}", routeColor: style?.routeColor ?? .systemGreen)
    }

    /// The style with a pair of sources (map, relief) per area in Areas/, each layer once per area, and the
    /// planner's colour for a paved route from its metadata.
    private static func style() -> (json: String, routeColor: UIColor)? {
        guard let url = Bundle.main.url(forResource: "style", withExtension: "json", subdirectory: "Map"),
              let data = try? Data(contentsOf: url),
              var style = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let layers = style["layers"] as? [[String: Any]],
              let folder = Bundle.main.resourceURL?.appending(path: "Areas"),
              let ids = try? FileManager.default.contentsOfDirectory(atPath: folder.path).sorted() else { return nil }
        var sources: [String: Any] = [:]
        for (name, source) in style["sources"] as? [String: [String: Any]] ?? [:] {
            for id in ids {
                let file = folder.appending(path: "\(id)/\(name).pmtiles")
                sources["\(name)-\(id)"] = source.merging(["url": "pmtiles://\(file.absoluteString)"]) { $1 }
            }
        }
        style["sources"] = sources
        style["layers"] = layers.flatMap { layer -> [[String: Any]] in
            guard let source = layer["source"] as? String else { return [layer] }
            return ids.map { id in layer.merging(["id": "\(layer["id"] ?? "")-\(id)", "source": "\(source)-\(id)"]) { $1 } }
        }
        let paved = ((style["metadata"] as? [String: Any])?["richiroute:route"] as? [String: Any])?["paved"] as? String
        let rgb = Int(paved?.dropFirst() ?? "", radix: 16) ?? 0
        let color = UIColor(red: CGFloat(rgb >> 16 & 0xff) / 255, green: CGFloat(rgb >> 8 & 0xff) / 255, blue: CGFloat(rgb & 0xff) / 255, alpha: 1)
        guard let json = try? JSONSerialization.data(withJSONObject: style) else { return nil }
        return (String(decoding: json, as: UTF8.self), color)
    }

    @MainActor
    final class Coordinator: NSObject, @preconcurrency MLNMapViewDelegate {
        let style: String
        private let routeColor: UIColor
        private var shown: Data?
        private var waiting: Data?
        private var source: MLNShapeSource?

        init(style: String, routeColor: UIColor) {
            self.style = style
            self.routeColor = routeColor
        }

        func mapView(_ map: MLNMapView, didFinishLoading style: MLNStyle) {
            let source = MLNShapeSource(identifier: "route", shape: nil)
            style.addSource(source)
            let outline = MLNLineStyleLayer(identifier: "route-outline", source: source)
            outline.lineColor = NSExpression(forConstantValue: UIColor.white)
            outline.lineWidth = NSExpression(forConstantValue: 8)
            let line = MLNLineStyleLayer(identifier: "route", source: source)
            line.lineColor = NSExpression(forConstantValue: routeColor)
            line.lineWidth = NSExpression(forConstantValue: 5)
            for layer in [outline, line] {
                layer.lineCap = NSExpression(forConstantValue: "round")
                layer.lineJoin = NSExpression(forConstantValue: "round")
                style.addLayer(layer)
            }
            self.source = source
            show(waiting, on: map)
        }

        func show(_ route: Data?, on map: MLNMapView) {
            guard let source else { return waiting = route }
            guard route != shown else { return }
            shown = route
            let shape = route.flatMap { try? MLNShape(data: $0, encoding: String.Encoding.utf8.rawValue) }
            source.shape = shape
            guard let bounds = ((shape as? MLNShapeCollectionFeature)?.shapes.first as? MLNOverlay)?.overlayBounds else { return }
            map.setVisibleCoordinateBounds(bounds, edgePadding: UIEdgeInsets(top: 40, left: 30, bottom: 40, right: 30), animated: true, completionHandler: nil)
        }
    }
}
