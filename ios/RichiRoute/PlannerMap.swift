import MapLibre
import SwiftUI

/// The offline map with the route drawn as the planner draws it: each leg in its surfaces' colours over a white
/// outline, dashed while it is routed (red where it failed), and the stops as S, 1, 2 … Z, which a held finger
/// drags.
struct PlannerMap: UIViewRepresentable {
    let content: MapContent
    /// The bottom panel's height, which framing the route leaves free.
    let bottomInset: CGFloat
    /// Counts the requests to follow the rider's position.
    let locating: Int
    let tap: (_ coord: [Double], _ leg: Int?) -> Void
    let move: (_ stop: UUID, _ coord: [Double]) -> Void
    /// Reports the map's centre after each move.
    let moved: (_ center: [Double]) -> Void

    func makeUIView(context: Context) -> MLNMapView {
        let map = MLNMapView(frame: .zero)
        map.delegate = context.coordinator
        map.styleJSON = MapStyle.shared.json
        map.setCenter(CLLocationCoordinate2D(latitude: 47.0707, longitude: 15.4395), zoomLevel: 13, animated: false)
        // the panel names the map's sources at its end and covers the map's bottom; the compass leaves the buttons room
        map.attributionButton.isHidden = true
        map.logoView.isHidden = true
        map.compassViewPosition = .topLeft
        let tapping = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.tapped(_:)))
        // a double tap zooms, so a single tap waits for it to fail
        for case let double as UITapGestureRecognizer in map.gestureRecognizers ?? [] where double.numberOfTapsRequired == 2 {
            tapping.require(toFail: double)
        }
        map.addGestureRecognizer(tapping)
        let holding = UILongPressGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.dragged(_:)))
        holding.minimumPressDuration = 0.25
        holding.delegate = context.coordinator
        map.addGestureRecognizer(holding)
        return map
    }

    func updateUIView(_ map: MLNMapView, context: Context) {
        context.coordinator.tap = tap
        context.coordinator.move = move
        context.coordinator.moved = moved
        context.coordinator.bottomInset = bottomInset
        context.coordinator.show(content, on: map)
        context.coordinator.locate(locating, on: map)
    }

    func makeCoordinator() -> Coordinator { Coordinator(tap: tap, move: move, moved: moved) }

    @MainActor
    final class Coordinator: NSObject, @preconcurrency MLNMapViewDelegate, UIGestureRecognizerDelegate {
        var tap: (_ coord: [Double], _ leg: Int?) -> Void
        var move: (_ stop: UUID, _ coord: [Double]) -> Void
        var moved: (_ center: [Double]) -> Void
        /// The stop a finger holds, while it drags it.
        private var held: UUID?
        var bottomInset: CGFloat = 0
        private var lines: MLNShapeSource?
        private var pins: MLNShapeSource?
        private var shown: MapContent?
        private var waiting: MapContent?
        private var located = 0

        init(tap: @escaping (_ coord: [Double], _ leg: Int?) -> Void, move: @escaping (_ stop: UUID, _ coord: [Double]) -> Void,
             moved: @escaping (_ center: [Double]) -> Void) {
            self.tap = tap
            self.move = move
            self.moved = moved
        }

        func mapView(_ map: MLNMapView, regionDidChangeAnimated animated: Bool) {
            moved([map.centerCoordinate.longitude, map.centerCoordinate.latitude])
        }

        func mapView(_ map: MLNMapView, didFinishLoading style: MLNStyle) {
            let lines = MLNShapeSource(identifier: "route", shape: nil)
            let pins = MLNShapeSource(identifier: "stops", shape: nil)
            style.addSource(lines)
            style.addSource(pins)
            let colors = MapStyle.shared
            let routed = NSPredicate(format: "style != 'waiting' AND style != 'air'")

            let outline = MLNLineStyleLayer(identifier: "route-outline", source: lines)
            outline.predicate = routed
            outline.lineColor = NSExpression(forConstantValue: UIColor.white)
            outline.lineWidth = NSExpression(forConstantValue: 9)
            let line = MLNLineStyleLayer(identifier: "route-line", source: lines)
            line.predicate = routed
            let bySurface: [Any] = ["match", ["get", "style"]]
                + Surface.allCases.dropLast().flatMap { [$0.rawValue, colors.hex($0.rawValue)] as [Any] } + [colors.hex(Surface.unknown.rawValue)]
            line.lineColor = NSExpression(mglJSONObject: bySurface)
            line.lineWidth = NSExpression(forConstantValue: 5)
            let pending = MLNLineStyleLayer(identifier: "route-pending", source: lines)
            pending.predicate = NSCompoundPredicate(notPredicateWithSubpredicate: routed)
            pending.lineColor = NSExpression(mglJSONObject: ["match", ["get", "style"], "air", colors.hex("air"), colors.hex("waiting")])
            pending.lineWidth = NSExpression(forConstantValue: 3)
            pending.lineDashPattern = NSExpression(forConstantValue: [2, 2])
            for layer in [outline, line, pending] {
                layer.lineCap = NSExpression(forConstantValue: "round")
                layer.lineJoin = NSExpression(forConstantValue: "round")
                style.addLayer(layer)
            }

            // the planner's markers: its ink, red for a stop without a road, a white ring
            let circles = MLNCircleStyleLayer(identifier: "stop-circles", source: pins)
            circles.circleRadius = NSExpression(forConstantValue: 12)
            circles.circleColor = NSExpression(mglJSONObject: ["case", ["get", "error"], MapStyle.dangerHex, MapStyle.inkHex])
            circles.circleStrokeColor = NSExpression(forConstantValue: UIColor.white)
            circles.circleStrokeWidth = NSExpression(forConstantValue: 2)
            let badges = MLNSymbolStyleLayer(identifier: "stop-badges", source: pins)
            badges.text = NSExpression(forKeyPath: "badge")
            badges.textFontNames = NSExpression(forConstantValue: ["Noto Sans Medium"])
            badges.textFontSize = NSExpression(forConstantValue: 12)
            badges.textColor = NSExpression(forConstantValue: UIColor.white)
            badges.textAllowsOverlap = NSExpression(forConstantValue: true)
            badges.textIgnoresPlacement = NSExpression(forConstantValue: true)
            style.addLayer(circles)
            style.addLayer(badges)

            self.lines = lines
            self.pins = pins
            if let waiting { show(waiting, on: map) }
        }

        func show(_ content: MapContent, on map: MLNMapView) {
            guard let lines, let pins else { return waiting = content }
            guard content != shown else { return }
            let reframe = content.framing != shown?.framing
            shown = content
            lines.shape = MLNShapeCollectionFeature(shapes: content.lines.map { line in
                let feature = MLNPolylineFeature(coordinates: line.coordinates.map(Self.coordinate), count: UInt(line.coordinates.count))
                feature.attributes = ["style": line.style, "leg": line.leg]
                return feature
            })
            draw(content.pins)
            if reframe { frame(content, on: map) }
        }

        private func draw(_ stops: [MapContent.Pin]) {
            pins?.shape = MLNShapeCollectionFeature(shapes: stops.map { pin in
                let feature = MLNPointFeature()
                feature.coordinate = Self.coordinate(pin.coord)
                feature.attributes = ["badge": pin.badge, "error": pin.error, "stop": pin.stop.uuidString]
                return feature
            })
        }

        /// The stop under a finger, with a finger's room around the marker.
        private func stop(at point: CGPoint, on map: MLNMapView) -> UUID? {
            let near = CGRect(x: point.x - 22, y: point.y - 22, width: 44, height: 44)
            return map.visibleFeatures(in: near, styleLayerIdentifiers: ["stop-circles"])
                .compactMap { ($0.attribute(forKey: "stop") as? String).flatMap(UUID.init) }.first
        }

        /// A long press starts only on a stop, so elsewhere the map keeps its own gestures.
        func gestureRecognizerShouldBegin(_ gesture: UIGestureRecognizer) -> Bool {
            guard gesture is UILongPressGestureRecognizer, let map = gesture.view as? MLNMapView else { return true }
            return stop(at: gesture.location(in: map), on: map) != nil
        }

        /// Holding a stop lifts it (a light tap), the finger drags it, letting go places it there.
        @objc func dragged(_ gesture: UILongPressGestureRecognizer) {
            guard let map = gesture.view as? MLNMapView, let shown else { return }
            let point = gesture.location(in: map)
            let coord = map.convert(point, toCoordinateFrom: map)
            switch gesture.state {
            case .began:
                held = stop(at: point, on: map)
                map.isScrollEnabled = false
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
            case .changed:
                guard let held else { return }
                draw(shown.pins.map { pin in
                    var pin = pin
                    if pin.stop == held { pin.coord = [coord.longitude, coord.latitude] }
                    return pin
                })
            default:
                map.isScrollEnabled = true
                defer { held = nil }
                guard let held else { return }
                if gesture.state == .ended { move(held, [coord.longitude, coord.latitude]) } else { draw(shown.pins) }
            }
        }

        private func frame(_ content: MapContent, on map: MLNMapView) {
            let points = content.lines.flatMap(\.coordinates) + content.pins.map(\.coord)
            guard let first = points.first else { return }
            var bounds = MLNCoordinateBounds(sw: Self.coordinate(first), ne: Self.coordinate(first))
            for point in points {
                bounds.sw = CLLocationCoordinate2D(latitude: min(bounds.sw.latitude, point[1]), longitude: min(bounds.sw.longitude, point[0]))
                bounds.ne = CLLocationCoordinate2D(latitude: max(bounds.ne.latitude, point[1]), longitude: max(bounds.ne.longitude, point[0]))
            }
            let padding = UIEdgeInsets(top: 80, left: 40, bottom: bottomInset + 40, right: 72)
            map.setVisibleCoordinateBounds(bounds, edgePadding: padding, animated: true, completionHandler: nil)
        }

        /// Shows the rider's position and follows it; the first time, iOS asks for permission.
        func locate(_ count: Int, on map: MLNMapView) {
            guard count != located else { return }
            located = count
            map.showsUserLocation = true
            map.setUserTrackingMode(.follow, animated: true, completionHandler: nil)
        }

        /// A tap on a routed leg adds a Zwischenstopp to it; anywhere else it places the next stop.
        @objc func tapped(_ gesture: UITapGestureRecognizer) {
            guard let map = gesture.view as? MLNMapView else { return }
            let point = gesture.location(in: map)
            let near = CGRect(x: point.x - 14, y: point.y - 14, width: 28, height: 28)
            let leg = map.visibleFeatures(in: near, styleLayerIdentifiers: ["route-line"])
                .compactMap { ($0.attribute(forKey: "leg") as? NSNumber)?.intValue }.first
            let coord = map.convert(point, toCoordinateFrom: map)
            tap([coord.longitude, coord.latitude], leg)
        }

        private static func coordinate(_ point: [Double]) -> CLLocationCoordinate2D {
            CLLocationCoordinate2D(latitude: point[1], longitude: point[0])
        }
    }
}
