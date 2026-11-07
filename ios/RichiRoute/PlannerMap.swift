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
    let basemap: Basemap
    let cycleRoutes: Bool
    /// Where Street View was asked for.
    let pin: LookPin?
    /// Whether the next tap shows Street View, after its button.
    let pickingStreetView: Bool
    let tap: (_ coord: [Double], _ leg: Int?) -> Void
    let move: (_ stop: UUID, _ coord: [Double]) -> Void
    let shape: (_ coord: [Double], _ leg: Int) -> Void
    /// Reports the map's centre after each move.
    let moved: (_ center: [Double]) -> Void
    /// Receives the way to show the profile's point under the finger, once the map is made.
    let pointer: (_ show: @escaping ([Double]?) -> Void) -> Void
    /// Reports, once the map has drawn, whether it has an offline map where the rider looks.
    let covered: (Bool) -> Void
    /// A suggested loop tapped on the map, by its place among them.
    let chooseLoop: (Int) -> Void
    /// A tap for Street View, or on its pin: Street View there; none clears the pin.
    let look: ([Double]?) -> Void

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
        holding.allowableMovement = Coordinator.tremble
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
        context.coordinator.chooseLoop = chooseLoop
        context.coordinator.look = look
        context.coordinator.pickingStreetView = pickingStreetView
        context.coordinator.show(pin, on: map)
        context.coordinator.bottomInset = bottomInset
        context.coordinator.show(content, on: map)
        context.coordinator.layers(basemap, cycleRoutes: cycleRoutes, on: map)
        context.coordinator.locate(locating, on: map)
    }

    func makeCoordinator() -> Coordinator { Coordinator(tap: tap, move: move, shape: shape, moved: moved) }

    @MainActor
    final class Coordinator: NSObject, @preconcurrency MLNMapViewDelegate, UIGestureRecognizerDelegate {
        var tap: (_ coord: [Double], _ leg: Int?) -> Void
        var move: (_ stop: UUID, _ coord: [Double]) -> Void
        var shape: (_ coord: [Double], _ leg: Int) -> Void
        var moved: (_ center: [Double]) -> Void
        /// What a held finger holds, and where it came down: a stop or Formpunkt, the route on a leg, or an empty spot.
        private enum Held {
            case stop(UUID, from: CGPoint), route(leg: Int, from: CGPoint), place(from: CGPoint)

            var from: CGPoint {
                switch self {
                case .stop(_, let from), .route(_, let from), .place(let from): from
                }
            }
        }
        private var held: Held?
        var bottomInset: CGFloat = 0
        var dark = false
        private var lines: MLNShapeSource?
        private var pins: MLNShapeSource?
        private var stretch: MLNShapeSource?
        private var focused: MLNShapeSource?
        private var arrows: MLNShapeSource?
        /// The route's outline and line, faded on the light map while a stretch is brought out.
        private var faded: [MLNStyleLayer] = []
        private var focus: MLNShapeSource?
        private var shown: MapContent?
        private var waiting: MapContent?
        private var located = 0
        var covered: (Bool) -> Void = { _ in }
        var chooseLoop: (Int) -> Void = { _ in }
        var look: ([Double]?) -> Void = { _ in }
        var pickingStreetView = false
        private var loops: MLNShapeSource?
        /// The offline map's own layers, and the base map and cycle routes shown with it.
        private var mapLayers: [MLNStyleLayer] = []
        /// The planner's lowest layer: the online maps go under the route.
        private var lowest: MLNStyleLayer?
        private var choice: (basemap: Basemap, cycleRoutes: Bool) = (.map, false)
        /// What of that choice the style shows; none once a change of appearance loads it afresh.
        private var shownBasemap: Basemap?
        private var shownCycleRoutes: Bool?

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
            // an online map shows where the offline one would be missing
            guard choice.basemap == .map else { return covered(true) }
            let middle = CGPoint(x: map.bounds.midX, y: (map.safeAreaInsets.top + map.bounds.height - bottomInset) / 2)
            let near = CGRect(x: middle.x - 30, y: middle.y - 30, width: 60, height: 60)
            covered(!areaLayers.isEmpty && !map.visibleFeatures(in: near, styleLayerIdentifiers: areaLayers).isEmpty)
        }

        func mapView(_ map: MLNMapView, regionDidChangeAnimated animated: Bool) {
            moved([map.centerCoordinate.longitude, map.centerCoordinate.latitude])
        }

        /// The online base map under the route (the offline map's own layers hidden: under terrain all of them, under
        /// aerial photos all but its names), and the signed cycle routes over it; each set again only when it changes.
        func layers(_ basemap: Basemap, cycleRoutes: Bool, on map: MLNMapView) {
            choice = (basemap, cycleRoutes)
            guard let style = map.style, let lowest else { return }
            if shownCycleRoutes != cycleRoutes {
                shownCycleRoutes = cycleRoutes
                raster("cycle-routes", cycleRoutes ? [Basemap.cycleRoutes] : [], maximumZoom: 18, bounds: nil, below: lowest, on: style)
            }
            if shownBasemap != basemap {
                shownBasemap = basemap
                for layer in mapLayers { layer.isVisible = basemap == .map || basemap == .aerial && layer is MLNSymbolStyleLayer }
                raster("online-base", basemap.tiles, maximumZoom: basemap.maximumZoom, bounds: basemap.bounds,
                       below: style.layer(withIdentifier: "cycle-routes") ?? lowest, on: style)
            }
        }

        private func raster(_ id: String, _ tiles: [String], maximumZoom: Int, bounds: MLNCoordinateBounds?, below: MLNStyleLayer,
                            on style: MLNStyle) {
            if let layer = style.layer(withIdentifier: id) { style.removeLayer(layer) }
            if let source = style.source(withIdentifier: id) { style.removeSource(source) }
            guard !tiles.isEmpty else { return }
            var options: [MLNTileSourceOption: Any] = [.tileSize: 256, .maximumZoomLevel: maximumZoom]
            if let bounds { options[.coordinateBounds] = NSValue(mlnCoordinateBounds: bounds) }
            let source = MLNRasterTileSource(identifier: id, tileURLTemplates: tiles, options: options)
            style.addSource(source)
            style.insertLayer(MLNRasterStyleLayer(identifier: id, source: source), below: below)
        }

        private var pin: MLNPointAnnotation?
        private var pinView: PinView?
        private var shownPin: LookPin?

        /// Drops the pin where Street View was asked for, shows its note, and fades it away when it goes.
        func show(_ look: LookPin?, on map: MLNMapView) {
            guard look != shownPin else { return }
            shownPin = look
            if let pin, look?.coordinate != [pin.coordinate.longitude, pin.coordinate.latitude] {
                let view = pinView
                (self.pin, pinView) = (nil, nil)
                UIView.animate(withDuration: 0.2) { view?.alpha = 0 } completion: { _ in map.removeAnnotation(pin) }
            }
            guard let look else { return }
            if pin == nil {
                let pin = MLNPointAnnotation()
                pin.coordinate = Self.coordinate(look.coordinate)
                self.pin = pin
                map.addAnnotation(pin)
            }
            pinView?.show(look.state)
        }

        func mapView(_ map: MLNMapView, viewFor annotation: MLNAnnotation) -> MLNAnnotationView? {
            guard annotation === pin, let shownPin else { return nil }
            let view = PinView(state: shownPin.state)
            pinView = view
            return view
        }

        /// The rider's dot without the library's pulse around it, calm as on Apple Maps; its accuracy circle stays.
        private let locationStyle = {
            let style = MLNUserLocationAnnotationViewStyle()
            style.haloFillColor = .clear
            return style
        }()

        func mapView(styleForDefaultUserLocationAnnotationView map: MLNMapView) -> MLNUserLocationAnnotationViewStyle { locationStyle }

        /// Whether a finger is on the pin, its head or its needle.
        private func onPin(_ point: CGPoint, on map: MLNMapView) -> Bool {
            guard let pin else { return false }
            let foot = map.convert(pin.coordinate, toPointTo: map)
            return abs(point.x - foot.x) <= 22 && point.y <= foot.y + 6 && point.y >= foot.y - 56
        }

        /// Swaps in the light or dark map when the phone changes its appearance.
        func restyle(_ map: MLNMapView) {
            let dark = map.traitCollection.userInterfaceStyle == .dark
            guard dark != self.dark else { return }
            self.dark = dark
            (lines, pins, stretch, focused, arrows, loops, focus) = (nil, nil, nil, nil, nil, nil, nil)
            (mapLayers, lowest) = ([], nil)
            map.styleJSON = MapStyle.shared.json(dark: dark)
        }

        func mapView(_ map: MLNMapView, didFinishLoading style: MLNStyle) {
            mapLayers = style.layers
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
            let waitingColor = dark ? MapStyle.greyHex : colors.hex("waiting")
            pending.lineColor = NSExpression(mglJSONObject: ["match", ["get", "style"], "air", colors.hex("air"), waitingColor])
            pending.lineWidth = NSExpression(forConstantValue: 3)
            pending.lineDashPattern = NSExpression(forConstantValue: [2, 2])
            // the part of a beeline its search has covered, filled in
            let filled = MLNLineStyleLayer(identifier: "route-progress", source: lines)
            filled.predicate = NSPredicate(format: "style == 'progress'")
            filled.lineColor = pending.lineColor
            filled.lineWidth = NSExpression(forConstantValue: 3)
            // the stretch the profile is zoomed into, or a surface section. On the light map the route along it is raised
            // on a wider outline, its ends marked, and the rest fades, as the planner draws it. On the dark map a soft light
            // glow lies beneath it, which the white outline can't be taken for; its line smoothed, as a blurred line draws
            // slashes across itself at a road's small jogs, and the blur hides the smoothing.
            // which way the route runs: the planner's arrows, evenly along each calculated stretch of it, turned with it
            let arrows = MLNShapeSource(identifier: "arrows", shape: nil)
            style.addSource(arrows)
            style.setImage(Self.arrow, forName: "route-arrow")
            let arrowLayer = { (id: String, focused: Bool) in
                let layer = MLNSymbolStyleLayer(identifier: id, source: arrows)
                layer.predicate = NSPredicate(format: "focused == %@", NSNumber(value: focused))
                layer.symbolPlacement = NSExpression(forConstantValue: "line")
                layer.symbolSpacing = NSExpression(forConstantValue: 110)
                layer.iconImageName = NSExpression(forConstantValue: "route-arrow")
                layer.iconRotationAlignment = NSExpression(forConstantValue: "map")
                layer.iconAllowsOverlap = NSExpression(forConstantValue: true)
                layer.iconIgnoresPlacement = NSExpression(forConstantValue: true)
                return layer
            }
            let routeArrows = arrowLayer("route-arrows", false)
            // loops suggested from the Start, as Apple Maps shows other routes: the chosen one strong, the others light,
            // each with its distance and climbing
            let loops = MLNShapeSource(identifier: "loops", shape: nil)
            style.addSource(loops)
            let loopLines = { (id: String, chosen: Bool) in
                let layer = MLNLineStyleLayer(identifier: id, source: loops)
                layer.predicate = NSPredicate(format: "$geometryType == 'LineString' AND chosen == %@", NSNumber(value: chosen))
                return layer
            }
            // the chosen loop blue, as the planner's first loop and Apple Maps' routes, on a dark outline on the dark map; the
            // others grey, their figures a little darker, to read
            let (strong, grey, greyText) = dark ? ("#6b95f0", "#6c7370", MapStyle.greyHex) : (colors.hex("loop"), MapStyle.greyHex, "#6c7370")
            let others = loopLines("loop-others", false)
            others.lineColor = NSExpression(forConstantValue: MapStyle.color(hex: grey))
            others.lineWidth = NSExpression(forConstantValue: 4)
            let loopOutline = loopLines("loop-outline", true)
            loopOutline.lineColor = dark ? NSExpression(forConstantValue: MapStyle.ink) : outline.lineColor
            loopOutline.lineWidth = outline.lineWidth
            let loopLine = loopLines("loop-line", true)
            loopLine.lineColor = NSExpression(forConstantValue: MapStyle.color(hex: strong))
            loopLine.lineWidth = line.lineWidth
            let figures = MLNSymbolStyleLayer(identifier: "loop-figures", source: loops)
            figures.predicate = NSPredicate(format: "$geometryType == 'Point'")
            figures.text = NSExpression(forKeyPath: "label")
            figures.textFontNames = NSExpression(forConstantValue: ["Noto Sans Medium"])
            figures.textFontSize = NSExpression(forConstantValue: 14)
            figures.textColor = NSExpression(mglJSONObject: ["case", ["get", "chosen"], strong, greyText])
            figures.textHaloColor = NSExpression(forConstantValue: dark ? UIColor(red: 0x1e / 255, green: 0x22 / 255, blue: 0x21 / 255, alpha: 1) : .white)
            figures.textHaloWidth = NSExpression(forConstantValue: 2)
            figures.symbolSortKey = NSExpression(mglJSONObject: ["case", ["get", "chosen"], 1, 0])
            figures.textAllowsOverlap = NSExpression(forConstantValue: true)
            self.loops = loops
            var layers: [MLNStyleLayer] = [others, loopOutline, loopLine, outline, line, routeArrows, pending, filled]
            faded = []
            if dark {
                let stretch = MLNShapeSource(identifier: "stretch", shape: nil, options: [.simplificationTolerance: 3])
                style.addSource(stretch)
                let glow = MLNLineStyleLayer(identifier: "stretch", source: stretch)
                glow.lineColor = NSExpression(forConstantValue: UIColor.white)
                glow.lineOpacity = NSExpression(forConstantValue: 0.5)
                glow.lineWidth = NSExpression(forConstantValue: 22)
                glow.lineBlur = NSExpression(forConstantValue: 6)
                layers.insert(glow, at: 0)
                self.stretch = stretch
            } else {
                let focused = MLNShapeSource(identifier: "focused", shape: nil)
                style.addSource(focused)
                let raisedOutline = MLNLineStyleLayer(identifier: "focused-outline", source: focused)
                raisedOutline.lineColor = outline.lineColor
                raisedOutline.lineWidth = NSExpression(forConstantValue: 13)
                let raised = MLNLineStyleLayer(identifier: "focused-line", source: focused)
                raised.lineColor = line.lineColor
                raised.lineWidth = NSExpression(forConstantValue: 8)
                let ends = MLNCircleStyleLayer(identifier: "focused-ends", source: focused)
                ends.predicate = NSPredicate(format: "end == YES")
                ends.circleRadius = NSExpression(forConstantValue: 6)
                ends.circleColor = NSExpression(forConstantValue: UIColor.white)
                ends.circleStrokeColor = NSExpression(forConstantValue: MapStyle.ink)
                ends.circleStrokeWidth = NSExpression(forConstantValue: 2.5)
                // over the route and its arrows
                layers.insert(contentsOf: [raisedOutline, raised, arrowLayer("focused-arrows", true), ends], at: layers.firstIndex(of: routeArrows)! + 1)
                faded = [outline, line, routeArrows]
                self.focused = focused
            }
            // under the map's names, as the planner draws it, so street and place names stay readable on the route
            let labels = style.layers.first { $0 is MLNSymbolStyleLayer }
            for layer in layers {
                if let layer = layer as? MLNLineStyleLayer {
                    layer.lineCap = NSExpression(forConstantValue: "round")
                    layer.lineJoin = NSExpression(forConstantValue: "round")
                }
                if let labels { style.insertLayer(layer, below: labels) } else { style.addLayer(layer) }
            }

            // the planner's markers: its ink, red for a stop without a road, a white ring; a Formpunkt white in an ink ring
            let stop = NSPredicate(format: "shape == NO"), formpunkt = NSPredicate(format: "shape == YES")
            let dots = MLNCircleStyleLayer(identifier: "shape-circles", source: pins)
            dots.predicate = formpunkt
            dots.circleRadius = NSExpression(forConstantValue: 7)
            dots.circleColor = NSExpression(forConstantValue: UIColor.white)
            dots.circleStrokeColor = NSExpression(mglJSONObject: ["case", ["get", "error"], MapStyle.dangerHex, MapStyle.inkHex])
            dots.circleStrokeWidth = NSExpression(forConstantValue: 4)
            // as on the planner, only zoomed in to edit the route, so a long one is not a chain of dots
            dots.minimumZoomLevel = 11
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
            style.addLayer(figures)
            // the profile's point under the finger, as the planner's
            let focus = MLNShapeSource(identifier: "focus", shape: nil)
            style.addSource(focus)
            let dot = MLNCircleStyleLayer(identifier: "focus", source: focus)
            dot.circleRadius = NSExpression(forConstantValue: 7)
            dot.circleColor = NSExpression(forConstantValue: UIColor.white)
            dot.circleStrokeColor = NSExpression(forConstantValue: MapStyle.ink)
            dot.circleStrokeWidth = NSExpression(forConstantValue: 3)
            style.addLayer(dot)
            self.focus = focus
            self.arrows = arrows

            self.lines = lines
            self.pins = pins
            areaLayers = Set(style.layers.compactMap { layer in
                (layer as? MLNForegroundStyleLayer)?.sourceIdentifier?.hasPrefix("map-") == true ? layer.identifier : nil
            })
            lowest = layers.first
            (shownBasemap, shownCycleRoutes) = (nil, nil)
            self.layers(choice.basemap, cycleRoutes: choice.cycleRoutes, on: map)
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
                let dot = Self.dot(end)
                dot.attributes = ["end": true]
                return dot
            }
            focused?.shape = MLNShapeCollectionFeature(shapes: content.focused.map(Self.feature) + ends)
            let opacity = NSExpression(forConstantValue: content.focused.isEmpty ? 1 : 0.35)
            for layer in faded {
                (layer as? MLNLineStyleLayer)?.lineOpacity = opacity
                (layer as? MLNSymbolStyleLayer)?.iconOpacity = opacity
            }
            let routed = content.lines.filter { !["waiting", "air", "progress"].contains($0.style) }
            loops?.shape = MLNShapeCollectionFeature(shapes: content.loops.enumerated().flatMap { index, loop -> [MLNShape] in
                let line = MLNPolylineFeature(coordinates: loop.coordinates.map(Self.coordinate), count: UInt(loop.coordinates.count))
                line.attributes = ["index": index, "chosen": loop.chosen]
                // its figures halfway round, where a loop is farthest out
                let figures = Self.dot(loop.coordinates[loop.coordinates.count / 2])
                figures.attributes = ["index": index, "chosen": loop.chosen, "label": loop.label]
                return [line, figures]
            })
            let chosenLoop = content.loops.filter(\.chosen).map { Self.run($0.coordinates, focused: false) }
            arrows?.shape = MLNShapeCollectionFeature(shapes: chosenLoop + Self.runs(routed).map { Self.run($0, focused: false) }
                + Self.runs(content.focused).map { Self.run($0, focused: true) })
        }

        /// Lines joined where one ends where the next begins, so that the arrows run evenly over their joins.
        private static func runs(_ lines: [MapContent.Line]) -> [[[Double]]] {
            var runs: [[[Double]]] = []
            for line in lines {
                if let last = runs.last?.last, last == line.coordinates.first {
                    runs[runs.count - 1] += line.coordinates.dropFirst()
                } else {
                    runs.append(line.coordinates)
                }
            }
            return runs
        }

        private static func run(_ coordinates: [[Double]], focused: Bool) -> MLNPolylineFeature {
            let feature = MLNPolylineFeature(coordinates: coordinates.map(coordinate), count: UInt(coordinates.count))
            feature.attributes = ["focused": focused]
            return feature
        }

        /// The planner's arrow (`src/utils/route-arrows.ts`): white with a dark outline and a soft shadow, pointing along
        /// the line.
        private static let arrow = UIGraphicsImageRenderer(size: CGSize(width: 18, height: 18)).image { context in
            let path = UIBezierPath(), middle: CGFloat = 9
            path.move(to: CGPoint(x: middle + 6.5, y: middle))
            path.addLine(to: CGPoint(x: middle - 4.5, y: middle - 5.5))
            path.addLine(to: CGPoint(x: middle - 1.8, y: middle))
            path.addLine(to: CGPoint(x: middle - 4.5, y: middle + 5.5))
            path.close()
            path.lineJoinStyle = .round
            path.lineWidth = 1.2
            context.cgContext.setShadow(offset: CGSize(width: 0, height: 0.8), blur: 1.8, color: UIColor(white: 0, alpha: 0.3).cgColor)
            UIColor.white.setFill()
            path.fill()
            context.cgContext.setShadow(offset: .zero, blur: 0, color: nil)
            UIColor(red: 0x1c / 255, green: 0x24 / 255, blue: 0x21 / 255, alpha: 1).setStroke()
            path.stroke()
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
                feature.coordinate = Self.coordinate(pin.stop == carriedStop?.id ? carriedStop?.coord ?? pin.coord : pin.coord)
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

        /// A held finger and the map's own panning and zooming go together; holding a marker or the route stops the
        /// panning.
        func gestureRecognizer(_ gesture: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
            gesture is UILongPressGestureRecognizer
                && (other is UIPanGestureRecognizer || other is UIPinchGestureRecognizer || other is UIRotationGestureRecognizer)
        }

        /// A finger held on a marker or the route and moved carries the marker, or a new Formpunkt, above the finger:
        /// letting go places it where it rides. Held on an empty spot and moved, the map pans; let go without moving,
        /// anywhere, it was a tap. A second finger lets go of what is carried.
        @objc func dragged(_ gesture: UILongPressGestureRecognizer) {
            guard let map = gesture.view as? MLNMapView else { return }
            let point = gesture.location(in: map)
            switch gesture.state {
            case .began:
                if let stop = stop(at: point, on: map) {
                    held = .stop(stop, from: point)
                } else if let leg = leg(at: point, on: map) {
                    held = .route(leg: leg, from: point)
                } else {
                    held = .place(from: point)
                }
                if case .place = held {} else { map.isScrollEnabled = false }
            case .changed:
                guard let held else { return }
                if gesture.numberOfTouches > 1 {
                    // cancelled: the gesture ends as `.cancelled`
                    gesture.isEnabled = false
                    gesture.isEnabled = true
                    return
                }
                if case .place = held { return }
                if !carrying {
                    // a held finger trembles a few points; only a clear move carries
                    guard hypot(point.x - held.from.x, point.y - held.from.y) >= Self.tremble else { return }
                    carrying = true
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                    raise(at: point, on: map)
                }
                carry(to: point, on: map)
            default:
                map.isScrollEnabled = true
                raising?.cancel()
                let target = carried(point, on: map)
                let (held, carrying) = (held, carrying)
                (self.held, self.carrying, carriedStop, raised, lastCarried) = (nil, false, nil, 0, nil)
                focus?.shape = nil
                if let shown { draw(shown.pins) }
                guard gesture.state == .ended, let held else { return }
                if !carrying {
                    // a hold let go where it began was a slow tap
                    if hypot(point.x - held.from.x, point.y - held.from.y) < Self.tremble { tapped(at: point, on: map) }
                    return
                }
                switch held {
                case .stop(let id, _): move(id, target)
                case .route(let leg, _): shape(target, leg)
                case .place: break
                }
            }
        }

        /// How far a held finger may tremble and still count as still, as UIKit allows a long press.
        static let tremble: CGFloat = 12
        private var carrying = false

        /// How far above the finger a carried marker or Formpunkt rides, so the finger never hides where it lands.
        private static let lift: CGFloat = 48
        private var raised: CGFloat = 0
        private var raising: Task<Void, Never>?

        /// Lifts what the finger picked up to its place above the finger, eased over a moment, as Apple Maps lifts a pin.
        private func raise(at point: CGPoint, on map: MLNMapView) {
            raising?.cancel()
            raising = Task { @MainActor [weak self, weak map] in
                for step in 1...8 {
                    guard let self, let map, !Task.isCancelled else { return }
                    let done = Double(step) / 8
                    raised = Self.lift * CGFloat(1 - (1 - done) * (1 - done))
                    carry(to: lastCarried ?? point, on: map)
                    try? await Task.sleep(for: .milliseconds(16))
                }
            }
        }

        private var lastCarried: CGPoint?

        /// Draws what is carried at its place above the finger.
        private func carry(to point: CGPoint, on map: MLNMapView) {
            lastCarried = point
            let target = carried(point, on: map)
            switch held {
            case .stop(let id, _):
                carriedStop = (id, target)
                if let shown { draw(shown.pins) }
            case .route: focus?.shape = Self.dot(target)
            case .place, nil: break
            }
        }

        /// The stop being carried and where it rides, kept through a redraw of the route meanwhile.
        private var carriedStop: (id: UUID, coord: [Double])?

        /// Where what is carried would land: above the finger by as much as it is raised.
        private func carried(_ point: CGPoint, on map: MLNMapView) -> [Double] {
            let at = map.convert(CGPoint(x: point.x, y: point.y - raised), toCoordinateFrom: map)
            return [at.longitude, at.latitude]
        }

        /// The route with its stops, or the stretch the profile is zoomed into.
        private func bounds(of content: MapContent) -> MLNCoordinateBounds? {
            let points: [[Double]]
            if !content.loops.isEmpty {
                points = content.loops.flatMap(\.coordinates)
            } else if content.stretch.isEmpty || content.framesWhole {
                points = content.lines.flatMap(\.coordinates) + content.pins.map(\.coord)
            } else {
                points = content.stretch
            }
            guard let first = points.first else { return nil }
            var bounds = MLNCoordinateBounds(sw: Self.coordinate(first), ne: Self.coordinate(first))
            for point in points {
                bounds.sw = CLLocationCoordinate2D(latitude: min(bounds.sw.latitude, point[1]), longitude: min(bounds.sw.longitude, point[0]))
                bounds.ne = CLLocationCoordinate2D(latitude: max(bounds.ne.latitude, point[1]), longitude: max(bounds.ne.longitude, point[0]))
            }
            return bounds
        }

        private func frame(_ content: MapContent, on map: MLNMapView) {
            guard var bounds = bounds(of: content) else { return }
            // a stop alone with its streets around it, not as close as the map goes
            let room = 0.003
            if bounds.ne.latitude - bounds.sw.latitude < room && bounds.ne.longitude - bounds.sw.longitude < room {
                bounds.sw = CLLocationCoordinate2D(latitude: bounds.sw.latitude - room, longitude: bounds.sw.longitude - room)
                bounds.ne = CLLocationCoordinate2D(latitude: bounds.ne.latitude + room, longitude: bounds.ne.longitude + room)
            }
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
            tapped(at: gesture.location(in: map), on: map)
        }

        private func tapped(at point: CGPoint, on map: MLNMapView) {
            // a tap on the pin shows its Street View again; while Street View is chosen, a tap shows it there; any other
            // tap clears the pin
            if onPin(point, on: map), let pin { return look([pin.coordinate.longitude, pin.coordinate.latitude]) }
            let at = map.convert(point, toCoordinateFrom: map)
            if pickingStreetView { return look([at.longitude, at.latitude]) }
            if pin != nil { look(nil) }
            guard stop(at: point, on: map) == nil else { return }
            let near = CGRect(x: point.x - 14, y: point.y - 14, width: 28, height: 28)
            if let loop = map.visibleFeatures(in: near, styleLayerIdentifiers: ["loop-figures", "loop-line", "loop-others"])
                .compactMap({ ($0.attribute(forKey: "index") as? NSNumber)?.intValue }).first {
                return chooseLoop(loop)
            }
            tap([at.longitude, at.latitude], leg(at: point, on: map))
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

/// The pin where Street View was asked for, on the map: drawn by SwiftUI, its foot on the spot, letting touches through
/// to the map.
private final class PinView: MLNAnnotationView {
    private let mark: UIHostingController<LookPinMark>

    init(state: LookPin.State) {
        mark = UIHostingController(rootView: LookPinMark(state: state))
        super.init(reuseIdentifier: nil)
        frame = CGRect(origin: .zero, size: LookPinMark.size)
        mark.view.frame = bounds
        mark.view.backgroundColor = .clear
        addSubview(mark.view)
        // never selected or touched: the map's own taps find the pin
        isUserInteractionEnabled = false
        isEnabled = false
        scalesWithViewingDistance = false
        centerOffset = CGVector(dx: 0, dy: -LookPinMark.size.height / 2 + 2)
    }

    required init?(coder: NSCoder) { nil }

    func show(_ state: LookPin.State) { mark.rootView = LookPinMark(state: state) }
}
