import MapLibre
import SwiftUI

/// The offline map with the route drawn as the planner draws it: each leg in its surfaces' colours over a white
/// outline, dashed while it is routed (red where it failed), the stops as S, 1, 2 … Z and the Formpunkte as white
/// dots, which a held finger drags; held on the route, it drags the route into a new Formpunkt.
struct PlannerMap: UIViewRepresentable {
    let content: MapContent
    /// The bottom panel's height, which framing the route leaves free.
    let bottomInset: CGFloat
    /// Counts the requests to follow the rider's position.
    let locating: Int
    let tap: (_ coord: [Double], _ leg: Int?) -> Void
    let move: (_ stop: UUID, _ coord: [Double]) -> Void
    let shape: (_ coord: [Double], _ leg: Int) -> Void
    /// Reports the map's centre after each move.
    let moved: (_ center: [Double]) -> Void
    /// Receives the way to show the profile's point under the finger, once the map is made.
    let pointer: (_ show: @escaping ([Double]?) -> Void) -> Void
    /// Reports, once the map has drawn, whether it has an offline map where the rider looks.
    let covered: (Bool) -> Void

    func makeUIView(context: Context) -> MLNMapView {
        let map = MLNMapView(frame: .zero)
        map.delegate = context.coordinator
        // the map goes dark with the phone, as Apple's does, the route kept through the change
        context.coordinator.dark = context.environment.colorScheme == .dark
        map.styleJSON = MapStyle.shared.json(dark: context.coordinator.dark)
        map.registerForTraitChanges([UITraitUserInterfaceStyle.self]) { [weak coordinator = context.coordinator] (map: MLNMapView, _: UITraitCollection) in
            coordinator?.restyle(map)
        }
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
        pointer { [weak map, weak coordinator = context.coordinator] point in
            if let map { coordinator?.point(point, on: map) }
        }
        return map
    }

    func updateUIView(_ map: MLNMapView, context: Context) {
        context.coordinator.tap = tap
        context.coordinator.move = move
        context.coordinator.shape = shape
        context.coordinator.moved = moved
        context.coordinator.covered = covered
        context.coordinator.bottomInset = bottomInset
        context.coordinator.show(content, on: map)
        context.coordinator.locate(locating, on: map)
    }

    func makeCoordinator() -> Coordinator { Coordinator(tap: tap, move: move, shape: shape, moved: moved) }

    @MainActor
    final class Coordinator: NSObject, @preconcurrency MLNMapViewDelegate, UIGestureRecognizerDelegate {
        var tap: (_ coord: [Double], _ leg: Int?) -> Void
        var move: (_ stop: UUID, _ coord: [Double]) -> Void
        var shape: (_ coord: [Double], _ leg: Int) -> Void
        var moved: (_ center: [Double]) -> Void
        /// What a held finger drags: a stop or Formpunkt, or the route on a leg from where it was picked up.
        private enum Held { case stop(UUID), route(leg: Int, from: CGPoint) }
        private var held: Held?
        var bottomInset: CGFloat = 0
        var dark = false
        private var lines: MLNShapeSource?
        private var pins: MLNShapeSource?
        private var stretch: MLNShapeSource?
        private var focused: MLNShapeSource?
        /// The route's outline and line, faded on the light map while a stretch is brought out.
        private var routeLayers: [MLNLineStyleLayer] = []
        private var focus: MLNShapeSource?
        private var shown: MapContent?
        private var waiting: MapContent?
        private var located = 0
        var covered: (Bool) -> Void = { _ in }
        /// The layers drawn from the offline areas' maps.
        private var areaLayers: Set<String> = []

        init(tap: @escaping (_ coord: [Double], _ leg: Int?) -> Void, move: @escaping (_ stop: UUID, _ coord: [Double]) -> Void,
             shape: @escaping (_ coord: [Double], _ leg: Int) -> Void, moved: @escaping (_ center: [Double]) -> Void) {
            self.tap = tap
            self.move = move
            self.shape = shape
            self.moved = moved
        }

        /// Whether the middle of the map above the panel shows an offline map.
        func mapViewDidBecomeIdle(_ map: MLNMapView) {
            let middle = CGPoint(x: map.bounds.midX, y: (map.safeAreaInsets.top + map.bounds.height - bottomInset) / 2)
            let near = CGRect(x: middle.x - 30, y: middle.y - 30, width: 60, height: 60)
            covered(!areaLayers.isEmpty && !map.visibleFeatures(in: near, styleLayerIdentifiers: areaLayers).isEmpty)
        }

        func mapView(_ map: MLNMapView, regionDidChangeAnimated animated: Bool) {
            moved([map.centerCoordinate.longitude, map.centerCoordinate.latitude])
        }

        /// Swaps in the light or dark map when the phone changes its appearance.
        func restyle(_ map: MLNMapView) {
            let dark = map.traitCollection.userInterfaceStyle == .dark
            guard dark != self.dark else { return }
            self.dark = dark
            (lines, pins, stretch, focused, focus) = (nil, nil, nil, nil, nil)
            map.styleJSON = MapStyle.shared.json(dark: dark)
        }

        func mapView(_ map: MLNMapView, didFinishLoading style: MLNStyle) {
            let lines = MLNShapeSource(identifier: "route", shape: nil)
            let pins = MLNShapeSource(identifier: "stops", shape: nil)
            style.addSource(lines)
            style.addSource(pins)
            let colors = MapStyle.shared
            let routed = NSPredicate(format: "NOT style IN {'waiting', 'air', 'progress'}")

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
            pending.predicate = NSPredicate(format: "style IN {'waiting', 'air'}")
            let waitingColor = dark ? "#9aa29e" : colors.hex("waiting")
            pending.lineColor = NSExpression(mglJSONObject: ["match", ["get", "style"], "air", colors.hex("air"), waitingColor])
            pending.lineWidth = NSExpression(forConstantValue: 3)
            pending.lineDashPattern = NSExpression(forConstantValue: [2, 2])
            // the part of a beeline its search has covered, filled in
            let filled = MLNLineStyleLayer(identifier: "route-progress", source: lines)
            filled.predicate = NSPredicate(format: "style == 'progress'")
            filled.lineColor = pending.lineColor
            filled.lineWidth = NSExpression(forConstantValue: 3)
            // the stretch the profile is zoomed into, or a surface section: on the light map the route along it raised on
            // a wider outline, its ends marked, over the rest, which fades, as the planner draws it; on the dark map a soft
            // light glow beneath it, which the white outline can't be taken for. The glow's line smoothed, as a blurred line draws slashes across itself at a road's
            // small jogs; the blur hides the smoothing.
            let stretch = MLNShapeSource(identifier: "stretch", shape: nil, options: [.simplificationTolerance: 3])
            style.addSource(stretch)
            let lifted = MLNLineStyleLayer(identifier: "stretch", source: stretch)
            lifted.lineColor = NSExpression(forConstantValue: UIColor.white)
            lifted.lineOpacity = NSExpression(forConstantValue: 0.5)
            lifted.lineWidth = NSExpression(forConstantValue: 22)
            lifted.lineBlur = NSExpression(forConstantValue: 6)
            let focused = MLNShapeSource(identifier: "focused", shape: nil)
            style.addSource(focused)
            let focusedOutline = MLNLineStyleLayer(identifier: "focused-outline", source: focused)
            focusedOutline.lineColor = outline.lineColor
            focusedOutline.lineWidth = NSExpression(forConstantValue: 13)
            let focusedLine = MLNLineStyleLayer(identifier: "focused-line", source: focused)
            focusedLine.lineColor = line.lineColor
            focusedLine.lineWidth = NSExpression(forConstantValue: 8)
            let ends = MLNCircleStyleLayer(identifier: "focused-ends", source: focused)
            ends.predicate = NSPredicate(format: "end == YES")
            ends.circleRadius = NSExpression(forConstantValue: 6)
            ends.circleColor = NSExpression(forConstantValue: UIColor.white)
            ends.circleStrokeColor = NSExpression(forConstantValue: MapStyle.ink)
            ends.circleStrokeWidth = NSExpression(forConstantValue: 2.5)
            // under the map's names, as the planner draws it, so street and place names stay readable on the route
            let labels = style.layers.first { $0 is MLNSymbolStyleLayer }
            let layers: [MLNStyleLayer] = dark ? [lifted, outline, line, pending, filled] : [outline, line, focusedOutline, focusedLine, ends, pending, filled]
            for layer in layers {
                if let layer = layer as? MLNLineStyleLayer {
                    layer.lineCap = NSExpression(forConstantValue: "round")
                    layer.lineJoin = NSExpression(forConstantValue: "round")
                }
                if let labels { style.insertLayer(layer, below: labels) } else { style.addLayer(layer) }
            }
            routeLayers = dark ? [] : [outline, line]

            // the planner's markers: its ink, red for a stop without a road, a white ring; a Formpunkt white in an ink ring
            let stop = NSPredicate(format: "shape == NO"), formpunkt = NSPredicate(format: "shape == YES")
            let dots = MLNCircleStyleLayer(identifier: "shape-circles", source: pins)
            dots.predicate = formpunkt
            dots.circleRadius = NSExpression(forConstantValue: 7)
            dots.circleColor = NSExpression(forConstantValue: UIColor.white)
            dots.circleStrokeColor = NSExpression(mglJSONObject: ["case", ["get", "error"], MapStyle.dangerHex, MapStyle.inkHex])
            dots.circleStrokeWidth = NSExpression(forConstantValue: 4)
            let circles = MLNCircleStyleLayer(identifier: "stop-circles", source: pins)
            circles.predicate = stop
            circles.circleRadius = NSExpression(forConstantValue: 12)
            circles.circleColor = NSExpression(mglJSONObject: ["case", ["get", "error"], MapStyle.dangerHex, MapStyle.inkHex])
            circles.circleStrokeColor = NSExpression(forConstantValue: UIColor.white)
            circles.circleStrokeWidth = NSExpression(forConstantValue: 2)
            let badges = MLNSymbolStyleLayer(identifier: "stop-badges", source: pins)
            badges.predicate = stop
            badges.text = NSExpression(forKeyPath: "badge")
            badges.textFontNames = NSExpression(forConstantValue: ["Noto Sans Medium"])
            badges.textFontSize = NSExpression(forConstantValue: 12)
            badges.textColor = NSExpression(forConstantValue: UIColor.white)
            badges.textAllowsOverlap = NSExpression(forConstantValue: true)
            badges.textIgnoresPlacement = NSExpression(forConstantValue: true)
            style.addLayer(dots)
            style.addLayer(circles)
            style.addLayer(badges)
            // the profile's point under the finger, as the planner's
            let focus = MLNShapeSource(identifier: "focus", shape: nil)
            style.addSource(focus)
            let dot = MLNCircleStyleLayer(identifier: "focus", source: focus)
            dot.circleRadius = NSExpression(forConstantValue: 7)
            dot.circleColor = NSExpression(forConstantValue: UIColor.white)
            dot.circleStrokeColor = NSExpression(forConstantValue: MapStyle.ink)
            dot.circleStrokeWidth = NSExpression(forConstantValue: 3)
            style.addLayer(dot)
            self.stretch = stretch
            self.focused = focused
            self.focus = focus

            self.lines = lines
            self.pins = pins
            areaLayers = Set(style.layers.compactMap { layer in
                (layer as? MLNForegroundStyleLayer)?.sourceIdentifier?.hasPrefix("map-") == true ? layer.identifier : nil
            })
            // after a change of appearance the route is drawn again where it was; what came meanwhile follows
            if let shown { fill(shown) }
            if let waiting {
                self.waiting = nil
                show(waiting, on: map)
            }
        }

        func show(_ content: MapContent, on map: MLNMapView) {
            guard lines != nil, pins != nil else { return waiting = content }
            guard content != shown else { return }
            let reframe = content.framing != shown?.framing
            shown = content
            fill(content)
            if reframe { frame(content, on: map) }
        }

        private func fill(_ content: MapContent) {
            lines?.shape = MLNShapeCollectionFeature(shapes: content.lines.map(Self.feature))
            draw(content.pins)
            stretch?.shape = content.stretch.count > 1
                ? MLNPolylineFeature(coordinates: content.stretch.map(Self.coordinate), count: UInt(content.stretch.count)) : nil
            let ends: [MLNShape] = content.focused.isEmpty ? [] : [content.stretch.first, content.stretch.last].compactMap { $0 }.map { end in
                let point = MLNPointFeature()
                point.coordinate = Self.coordinate(end)
                point.attributes = ["end": true]
                return point
            }
            focused?.shape = MLNShapeCollectionFeature(shapes: content.focused.map(Self.feature) + ends)
            for layer in routeLayers { layer.lineOpacity = NSExpression(forConstantValue: content.focused.isEmpty ? 1 : 0.35) }
        }

        private static func feature(_ line: MapContent.Line) -> MLNPolylineFeature {
            let feature = MLNPolylineFeature(coordinates: line.coordinates.map(coordinate), count: UInt(line.coordinates.count))
            feature.attributes = ["style": line.style, "leg": line.leg]
            return feature
        }

        /// The profile's point under the finger. As the finger comes down, the route is brought out from under the
        /// panel when part of it is there, so the point stays in sight as it moves.
        func point(_ point: [Double]?, on map: MLNMapView) {
            if focus?.shape == nil, point != nil, let shown, !inSight(shown, on: map) { frame(shown, on: map) }
            focus?.shape = point.map(Self.dot)
        }

        /// Whether the route, or its zoomed stretch, lies in the map above the panel; never where too little of the
        /// map is left to show it.
        private func inSight(_ content: MapContent, on map: MLNMapView) -> Bool {
            guard let bounds = bounds(of: content) else { return true }
            let free = CGRect(x: 0, y: map.safeAreaInsets.top, width: map.bounds.width, height: map.bounds.height - map.safeAreaInsets.top - bottomInset)
            guard free.height >= 160 else { return true }
            return [bounds.sw, bounds.ne].allSatisfy { free.contains(map.convert($0, toPointTo: map)) }
        }

        private func draw(_ stops: [MapContent.Pin]) {
            pins?.shape = MLNShapeCollectionFeature(shapes: stops.map { pin in
                let feature = MLNPointFeature()
                feature.coordinate = Self.coordinate(pin.coord)
                feature.attributes = ["badge": pin.badge ?? "", "shape": pin.badge == nil, "error": pin.error, "stop": pin.stop.uuidString]
                return feature
            })
        }

        /// The stop or Formpunkt under a finger, with a finger's room around the marker.
        private func stop(at point: CGPoint, on map: MLNMapView) -> UUID? {
            let near = CGRect(x: point.x - 22, y: point.y - 22, width: 44, height: 44)
            return map.visibleFeatures(in: near, styleLayerIdentifiers: ["stop-circles", "shape-circles"])
                .compactMap { ($0.attribute(forKey: "stop") as? String).flatMap(UUID.init) }.first
        }

        /// The routed leg under a finger.
        private func leg(at point: CGPoint, on map: MLNMapView) -> Int? {
            let near = CGRect(x: point.x - 14, y: point.y - 14, width: 28, height: 28)
            return map.visibleFeatures(in: near, styleLayerIdentifiers: ["route-line"])
                .compactMap { ($0.attribute(forKey: "leg") as? NSNumber)?.intValue }.first
        }

        /// A long press starts only on a marker or the route, so elsewhere the map keeps its own gestures.
        func gestureRecognizerShouldBegin(_ gesture: UIGestureRecognizer) -> Bool {
            guard gesture is UILongPressGestureRecognizer, let map = gesture.view as? MLNMapView else { return true }
            let point = gesture.location(in: map)
            return stop(at: point, on: map) != nil || leg(at: point, on: map) != nil
        }

        /// Holding a marker or the route lifts it (a light tap) and the finger drags it: letting go places the marker
        /// there, or a Formpunkt where the route was dragged (as the planner, only once it moved).
        @objc func dragged(_ gesture: UILongPressGestureRecognizer) {
            guard let map = gesture.view as? MLNMapView, let shown else { return }
            let point = gesture.location(in: map)
            let at = map.convert(point, toCoordinateFrom: map)
            let coord = [at.longitude, at.latitude]
            switch (gesture.state, held) {
            case (.began, _):
                if let stop = stop(at: point, on: map) {
                    held = .stop(stop)
                } else if let leg = leg(at: point, on: map) {
                    held = .route(leg: leg, from: point)
                }
                map.isScrollEnabled = false
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
            case (.changed, .stop(let id)):
                draw(shown.pins.map { pin in
                    var pin = pin
                    if pin.stop == id { pin.coord = coord }
                    return pin
                })
            case (.changed, .route):
                focus?.shape = Self.dot(coord)
            default:
                map.isScrollEnabled = true
                defer { held = nil }
                let done = gesture.state == .ended
                switch held {
                case .stop(let id): if done { move(id, coord) } else { draw(shown.pins) }
                case .route(let leg, let from):
                    focus?.shape = nil
                    if done && hypot(point.x - from.x, point.y - from.y) >= 6 { shape(coord, leg) }
                case nil: break
                }
            }
        }

        /// The route with its stops, or the stretch the profile is zoomed into.
        private func bounds(of content: MapContent) -> MLNCoordinateBounds? {
            let points = content.stretch.isEmpty ? content.lines.flatMap(\.coordinates) + content.pins.map(\.coord) : content.stretch
            guard let first = points.first else { return nil }
            var bounds = MLNCoordinateBounds(sw: Self.coordinate(first), ne: Self.coordinate(first))
            for point in points {
                bounds.sw = CLLocationCoordinate2D(latitude: min(bounds.sw.latitude, point[1]), longitude: min(bounds.sw.longitude, point[0]))
                bounds.ne = CLLocationCoordinate2D(latitude: max(bounds.ne.latitude, point[1]), longitude: max(bounds.ne.longitude, point[0]))
            }
            return bounds
        }

        private func frame(_ content: MapContent, on map: MLNMapView) {
            guard let bounds = bounds(of: content) else { return }
            // below the bars at the top (a hint or a confirmation) and beside the buttons
            let padding = UIEdgeInsets(top: 130, left: 40, bottom: bottomInset + 40, right: 72)
            map.setVisibleCoordinateBounds(bounds, edgePadding: padding, animated: true, completionHandler: nil)
        }

        /// Shows the rider's position and follows it; the first time, iOS asks for permission.
        func locate(_ count: Int, on map: MLNMapView) {
            guard count != located else { return }
            located = count
            map.showsUserLocation = true
            map.setUserTrackingMode(.follow, animated: true, completionHandler: nil)
        }

        /// A tap on a routed leg adds a Zwischenstopp to it; anywhere else it places the next stop. A marker takes no
        /// taps, as the planner's.
        @objc func tapped(_ gesture: UITapGestureRecognizer) {
            guard let map = gesture.view as? MLNMapView else { return }
            let point = gesture.location(in: map)
            guard stop(at: point, on: map) == nil else { return }
            let coord = map.convert(point, toCoordinateFrom: map)
            tap([coord.longitude, coord.latitude], leg(at: point, on: map))
        }

        private static func dot(_ point: [Double]) -> MLNPointFeature {
            let feature = MLNPointFeature()
            feature.coordinate = coordinate(point)
            return feature
        }

        private static func coordinate(_ point: [Double]) -> CLLocationCoordinate2D {
            CLLocationCoordinate2D(latitude: point[1], longitude: point[0])
        }
    }
}
