import MapLibre
import SwiftUI

/// The offline map (`MapStyle`) over the bundled areas, with a route
/// drawn on top in the planner's colours and fitted into view.
struct RouteMap: UIViewRepresentable {
    let route: Data?

    func makeUIView(context: Context) -> MLNMapView {
        let map = MLNMapView(frame: .zero)
        map.delegate = context.coordinator
        map.styleJSON = MapStyle.shared.json(dark: context.environment.colorScheme == .dark)
        map.setCenter(CLLocationCoordinate2D(latitude: 47.3, longitude: 13.5), zoomLevel: 6, animated: false)
        return map
    }

    func updateUIView(_ map: MLNMapView, context: Context) {
        context.coordinator.show(route, on: map)
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(routeColor: MapStyle.shared.color(.paved))
    }

    @MainActor
    final class Coordinator: NSObject, @preconcurrency MLNMapViewDelegate {
        private let routeColor: UIColor
        private var shown: Data?
        private var waiting: Data?
        private var source: MLNShapeSource?

        init(routeColor: UIColor) {
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
