import SwiftUI
import UIKit

/// The route's elevation profile as the engine's `/profile` draws it (`engine/planner/src/profile.rs`): x from 0 to
/// 300, y from 10 (highest) to 78 (lowest), colour runs by the steepest climb held in each stretch, each point's
/// distance and gradient per leg, and a zoomed stretch's figures.
struct Profile: Decodable, Equatable, Sendable {
    struct Stats: Decodable, Equatable, Sendable {
        let distance: Double
        let ascent: Double
        let gradient: Double?
        let steepest: Double?
    }

    let distance: Double
    let minimum: Double
    let maximum: Double
    let runs: [[[Double]]]
    /// Where each colour starts (0 to 1 along what is shown) and its band, < 3 %, 3 to 8 %, 8 to 15 %, ≥ 15 %.
    let colors: [[Double]]
    let along: [[Double]]
    let gradients: [[Double?]]
    let stats: Stats?

    /// The planner's colours of the bands (`gradientBands`, `src/domain/gpx-inspection.ts`).
    static let bands = [
        Color(red: 0x35 / 255, green: 0x9a / 255, blue: 0x78 / 255),
        Color(red: 0xd4 / 255, green: 0xa1 / 255, blue: 0x26 / 255),
        Color(red: 0xd5 / 255, green: 0x6b / 255, blue: 0x31 / 255),
        Color(red: 0xb9 / 255, green: 0x36 / 255, blue: 0x4f / 255),
    ]

    static func band(_ gradient: Double) -> Int { [3.0, 8, 15].firstIndex { gradient < $0 } ?? 3 }

    /// A point of the route at a distance along it (`inspectGpxDistance`): where it is, whether its leg has heights,
    /// and its gradient, between the points of the leg it lies on.
    struct Point: Equatable {
        let distance: Double
        let coordinate: [Double]
        let hasHeight: Bool
        let gradient: Double?
    }

    func point(at requested: Double, legs: [Leg]) -> Point? {
        guard !along.isEmpty, along.count == legs.count else { return nil }
        let at = min(max(0, requested), distance)
        let segment = max(0, Self.upperBound(along.count, { along[$0][0] }, at) - 1)
        let distances = along[segment], coordinates = legs[segment].coordinates
        let from = max(0, Self.upperBound(distances.count, { distances[$0] }, at) - 1)
        let to = min(distances.count - 1, from + 1)
        let span = distances[to] - distances[from]
        let ratio = span > 0 ? (at - distances[from]) / span : 0
        let (a, b) = (gradients[segment][from], gradients[segment][to])
        let coordinate = [coordinates[from][0] + (coordinates[to][0] - coordinates[from][0]) * ratio,
                          coordinates[from][1] + (coordinates[to][1] - coordinates[from][1]) * ratio]
        return Point(distance: at, coordinate: coordinate, hasHeight: legs[segment].elevations != nil,
                     gradient: ratio == 0 ? a : a.flatMap { a in b.map { a * (1 - ratio) + $0 * ratio } })
    }

    /// The route's points on each leg a stretch runs on, from the last at or before `from` to the first at or after
    /// `to`, `[leg, first, last]`, as a surface section's parts.
    func parts(from: Double, to: Double) -> [[Int]] {
        along.enumerated().compactMap { leg, distances in
            guard let start = distances.first, let end = distances.last, start < to, end > from else { return nil }
            return [leg, distances.lastIndex { $0 <= from } ?? 0, distances.firstIndex { $0 >= to } ?? distances.count - 1]
        }
    }

    /// The points with a height along the route, a missing height breaking the line into runs (`buildGpxTrack`).
    struct Sample {
        let distance: Double
        let height: Double
        let run: Int
    }

    func samples(legs: [Leg]) -> [Sample] {
        var samples: [Sample] = [], run = 1
        for (distances, leg) in zip(along, legs) {
            guard let heights = leg.elevations else {
                run += 1
                continue
            }
            samples += zip(distances, heights).map { Sample(distance: $0, height: $1, run: run) }
        }
        return samples
    }

    /// The height at a distance as the line shows it, averaged over `meters` around it within its run, so the
    /// figure and the dot agree with the line (`smoothedHeight`).
    static func smoothedHeight(_ samples: [Sample], at distance: Double, over meters: Double) -> Double? {
        guard !samples.isEmpty else { return nil }
        let at = max(0, upperBound(samples.count, { samples[$0].distance }, distance) - 1), run = samples[at].run
        let (a, b) = (distance - meters / 2, distance + meters / 2)
        var (first, last) = (at, at)
        while first > 0 && samples[first - 1].run == run && samples[first].distance > a { first -= 1 }
        while last < samples.count - 1 && samples[last + 1].run == run && samples[last].distance < b { last += 1 }
        var (area, length) = (0.0, 0.0)
        for k in first..<last {
            let (p, q) = (samples[k], samples[k + 1])
            let (x0, x1) = (max(a, p.distance), min(b, q.distance))
            guard x1 > x0 else { continue }
            let height = { (x: Double) in p.height + (q.height - p.height) * (x - p.distance) / (q.distance - p.distance) }
            area += (height(x0) + height(x1)) / 2 * (x1 - x0)
            length += x1 - x0
        }
        return length > 0 ? area / length : samples[at].height
    }

    /// The width a stretch is read at, a column's, from 100 to 500 m (`profileWindow`).
    static func window(_ span: Double) -> Double { min(500, max(100, span / 300)) }

    private static func upperBound(_ count: Int, _ value: (Int) -> Double, _ target: Double) -> Int {
        var (low, high) = (0, count)
        while low < high {
            let middle = (low + high) / 2
            if value(middle) <= target { low = middle + 1 } else { high = middle }
        }
        return low
    }
}

/// The elevation axis the profile is drawn on, as the planner's `ElevationChart`: it starts and ends on a round step,
/// at most five steps whose marks have room between them, the one wasting the least height. A nearly flat stretch
/// keeps some height on it, 1 % of its length (50 to 300 m), so a few metres up and down stay a gentle wave.
struct ProfileAxis: Equatable {
    let from: Double
    let to: Double
    let step: Double
    /// The drawn line (y 10 at its highest point to 78 at its lowest) placed on the axis: y × scale + offset.
    let scale: Double
    let offset: Double

    init(_ profile: Profile, span: Double, plotHeight: Double) {
        let least = min(300, max(50, span / 100))
        let middle = (profile.minimum + profile.maximum) / 2
        let half = max(profile.maximum - profile.minimum, least) / 2
        let (minimum, maximum) = (middle - half, middle + half)
        var best: (from: Double, to: Double, step: Double)?
        var (step, tried) = (Self.niceStep(max(5, (maximum - minimum) / 8)), 0)
        while tried < 6 || best == nil {
            let from = (minimum / step).rounded(.down) * step
            let to = max((maximum / step).rounded(.up) * step, from + step)
            let roomy = plotHeight * step / (to - from) >= min(plotHeight, max(11, plotHeight / 5))
            if roomy && to - from < (best.map { $0.to - $0.from } ?? .infinity) { best = (from, to, step) }
            tried += 1
            step = Self.niceStep(step * 1.01)
        }
        from = best!.from
        to = best!.to
        self.step = best!.step
        scale = max(1, profile.maximum - profile.minimum) / (to - from)
        offset = 78 - (profile.minimum - from) / (to - from) * 68 - 78 * scale
    }

    /// An elevation's y, 10 at the axis' top to 78 at its foot.
    func y(_ elevation: Double) -> Double { 78 - (elevation - from) / (to - from) * 68 }

    var marks: [Double] { (0...Int(((to - from) / step).rounded())).map { from + Double($0) * step } }

    /// A round step, 1, 2, 2.5 or 5 × 10ⁿ, at least `rough` (`niceStep`).
    static func niceStep(_ rough: Double) -> Double {
        let magnitude = pow(10, (log10(rough)).rounded(.down))
        return magnitude * ([1, 2, 2.5, 5].first { $0 * magnitude >= rough } ?? 10)
    }
}

/// The profile with its gradient colours on its axes, as the planner's: heights at the left, distances below, a faint
/// dotted line at each. A finger moved along it shows the point under it, in the heading and on the map; held still
/// for a moment first, it marks a stretch to zoom into.
struct ElevationProfile: View {
    let profile: Profile
    let legs: [Leg]
    /// The stretch shown, nil for the whole route.
    var range: ClosedRange<Double>? = nil
    let focus: (Profile.Point?) -> Void
    /// Zooms into a marked stretch; without it, a held finger only points.
    var zoom: ((ClosedRange<Double>?) -> Void)?

    /// The point under the finger with its height as the line shows it, worked out once per move.
    @State private var pointed: (point: Profile.Point, height: Double?)?
    @State private var selection: (start: Double, end: Double)?
    @State private var samples: [Profile.Sample] = []
    @ScaledMetric(relativeTo: .caption2) private var heightsWidth: CGFloat = 44

    /// The chart, its plot from y 10 to 78 of 88, so the line's highest point has room above and the distances sit
    /// close under it.
    private static let chartHeight: CGFloat = 112
    private static func plotY(_ y: Double) -> CGFloat { CGFloat(y / 88) * chartHeight }

    private var from: Double { range?.lowerBound ?? 0 }
    private var to: Double { range?.upperBound ?? profile.distance }
    private var axis: ProfileAxis { ProfileAxis(profile, span: to - from, plotHeight: Self.plotY(68)) }
    private var marked: ClosedRange<Double>? { selection.map { min($0.start, $0.end)...max($0.start, $0.end) } }

    private func x(_ meters: Double, width: CGFloat) -> CGFloat { CGFloat((meters - from) / max(to - from, 1)) * width }

    var body: some View {
        let axis = axis
        VStack(alignment: .leading, spacing: 8) {
            heading
            if let stats = profile.stats { figures(stats) }
            GeometryReader { size in
                let width = size.size.width - heightsWidth - 20
                let marks = distanceMarks(width: width)
                VStack(alignment: .leading, spacing: 0) {
                    HStack(spacing: 0) {
                        heights(axis)
                        chart(width: width, axis: axis, marks: marks.map(\.x))
                    }
                    distances(marks).padding(.leading, heightsWidth)
                }
            }
            .frame(height: Self.chartHeight + 18)
            if range == nil { SlopeScale().padding(.leading, heightsWidth) }
        }
        .onChange(of: profile, initial: true) {
            samples = profile.samples(legs: legs)
            pointed = nil
            focus(nil)
        }
        // gone while a finger is on it (a leg routed anew, another tab): its point leaves the map too
        .onDisappear { focus(nil) }
    }

    /// "Höhenprofil", in the panel's heading style; while a finger is on the profile, what it points at or marks, in
    /// place, so nothing covers the profile or moves about; and the way back from a stretch, or how to choose one.
    private var heading: some View {
        HStack(spacing: 8) {
            if let marked {
                Text("Ausschnitt \(Format.length(marked.upperBound - marked.lowerBound))")
                    .font(.subheadline.weight(.semibold).monospacedDigit())
            } else if let pointed {
                readout(pointed.point, height: pointed.height)
            } else {
                Text("Höhenprofil").font(.headline).foregroundStyle(Color.ink)
            }
            Spacer(minLength: 0)
            if range != nil {
                CloseButton(label: "Ausschnitt schließen") { zoom?(nil) }
            } else if zoom != nil && pointed == nil && selection == nil {
                Text("Zum Zoomen halten und ziehen").font(.caption).foregroundStyle(.secondary)
            }
        }
        .frame(minHeight: 44)
    }

    /// The point under the finger, as the planner's tooltip: height as the line shows it, distance, and the gradient
    /// with its colour.
    private func readout(_ point: Profile.Point, height: Double?) -> some View {
        HStack(spacing: 12) {
            Text(height.map { "\(Format.whole($0)) m" } ?? "Höhe unbekannt").fontWeight(.semibold)
            Text("\(Format.km(point.distance, digits: 2)) km").foregroundStyle(.secondary)
            if let gradient = point.gradient {
                HStack(spacing: 4) {
                    RoundedRectangle(cornerRadius: 2).fill(Profile.bands[Profile.band(gradient)]).frame(width: 10, height: 10)
                    Text("\(Format.gradient(gradient)) %")
                }
            }
        }
        .font(.subheadline.monospacedDigit())
    }

    /// A zoomed stretch's figures, as the planner's `ElevationRange`.
    private func figures(_ stats: Profile.Stats) -> some View {
        HStack(alignment: .top, spacing: 12) {
            figure("Ausschnitt", Format.length(stats.distance))
            figure("Höhenmeter", "\(Format.whole(stats.ascent)) hm")
            if let gradient = stats.gradient { figure("Ø Steigung", "\(Format.gradient(gradient)) %") }
            if let steepest = stats.steepest { figure("Max. Steigung", "\(Format.gradient(steepest)) %") }
        }
        .accessibilityElement(children: .combine)
    }

    private func figure(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.caption2).foregroundStyle(.secondary)
            Text(value).font(.subheadline.weight(.semibold).monospacedDigit())
        }
    }

    /// The axis' heights, each beside its line.
    private func heights(_ axis: ProfileAxis) -> some View {
        ZStack(alignment: .topTrailing) {
            ForEach(axis.marks, id: \.self) { mark in
                // centred on its line, wherever that is
                Text("\(Format.whole(mark)) m").fixedSize().frame(height: 0).offset(y: Self.plotY(axis.y(mark)))
            }
        }
        .font(.caption2.monospacedDigit())
        .foregroundStyle(.secondary)
        .padding(.trailing, 6)
        .frame(width: heightsWidth, height: Self.chartHeight, alignment: .topTrailing)
        .accessibilityHidden(true)
    }

    /// Distance marks at a round step, about one per 70 points, and the exact distance at the end (at both ends of a
    /// zoomed stretch), each centred on its line; a round mark too close to an exact one gives way.
    private func distanceMarks(width: CGFloat) -> [(x: CGFloat, label: String)] {
        let x = { (meters: Double) in self.x(meters, width: width) }
        let step = ProfileAxis.niceStep(max((to - from) / Double(max(2, Int(width / 70))), 10))
        let first = Int((from / step).rounded(.up)), last = Int((to / step).rounded(.down))
        let apart = { (a: Double, b: Double) in abs(x(a) - x(b)) >= 52 }
        let round = (first...max(first, last)).map { Double($0) * step }
            .filter { $0 <= to && apart($0, to) && (range == nil || apart($0, from)) }
        let exact = { (meters: Double) in (x: x(meters), label: "\(Format.km(meters, digits: 1)) km") }
        return (range == nil ? [] : [exact(from)]) + round.map { (x: x($0), label: "\(Format.km($0, digits: 3)) km") } + [exact(to)]
    }

    private func distances(_ marks: [(x: CGFloat, label: String)]) -> some View {
        ZStack(alignment: .topLeading) {
            ForEach(marks.indices, id: \.self) { i in
                Text(marks[i].label).fixedSize().frame(width: 0).offset(x: marks[i].x)
            }
        }
        .font(.caption2.monospacedDigit())
        .foregroundStyle(.secondary)
        .padding(.top, 2)
        .accessibilityHidden(true)
    }

    private func chart(width: CGFloat, axis: ProfileAxis, marks: [CGFloat]) -> some View {
        let x = { (meters: Double) in self.x(meters, width: width) }
        return ZStack(alignment: .topLeading) {
            ProfileLine(profile: profile, axis: axis, verticals: marks)
            if let marked {
                let (a, b) = (x(marked.lowerBound), x(marked.upperBound))
                Rectangle().fill(Color.ink.opacity(0.12)).frame(width: max(b - a, 2), height: Self.plotY(68))
                    .offset(x: a, y: Self.plotY(10))
            }
            if let pointed {
                let at = x(pointed.point.distance)
                Rectangle().fill(Color.secondary).frame(width: 1, height: Self.chartHeight - Self.plotY(4)).offset(x: at, y: Self.plotY(4))
                if let height = pointed.height {
                    Circle().fill(.white).stroke(Color(MapStyle.ink), lineWidth: 2).frame(width: 10, height: 10)
                        .offset(x: at - 5, y: Self.plotY(axis.y(height)) - 5)
                }
            }
        }
        .frame(width: width, height: Self.chartHeight, alignment: .topLeading)
        .contentShape(Rectangle())
        .gesture(ProfileTouch { state, mode, at in touched(state, mode, at: at, width: width) })
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Höhenprofil von \(Format.whole(profile.minimum)) bis \(Format.whole(profile.maximum)) m über \(Format.km(to - from)) km")
    }

    /// Pointing shows the point there and on the map until the finger lifts; a marked stretch is zoomed into when it is
    /// at least 50 m and a hundredth of what is shown (as the planner).
    private func touched(_ state: UIGestureRecognizer.State, _ mode: ProfileTouchRecognizer.Mode, at position: CGFloat, width: CGFloat) {
        let at = from + Double(min(max(position, 0), width) / max(width, 1)) * (to - from)
        switch (state, zoom == nil ? .point : mode) {
        case (.began, .select):
            selection = (at, at)
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
        case (.changed, .select):
            selection?.end = at
        case (.began, .point), (.changed, .point):
            let point = profile.point(at: at, legs: legs)
            pointed = point.map { ($0, $0.hasHeight ? Profile.smoothedHeight(samples, at: $0.distance, over: Profile.window(to - from)) : nil) }
            focus(point)
        default:
            if pointed != nil {
                pointed = nil
                focus(nil)
            }
            guard let chosen = marked else { return }
            selection = nil
            if state == .ended && chosen.upperBound - chosen.lowerBound >= max(50, (to - from) / 100) { zoom?(chosen) }
        }
    }
}

/// The faint dotted lines at the axis' marks, then the profile's line and the area under it in the gradient colours,
/// placed on the axis; drawn again only when the profile changes, not as the finger moves.
private struct ProfileLine: View {
    let profile: Profile
    let axis: ProfileAxis
    /// The distance marks' x, in points.
    let verticals: [CGFloat]

    var body: some View {
        Canvas { context, size in
            let y = { (drawn: Double) in CGFloat(drawn / 88) * size.height }
            var grid = Path()
            for mark in axis.marks {
                grid.move(to: CGPoint(x: 0, y: y(axis.y(mark))))
                grid.addLine(to: CGPoint(x: size.width, y: y(axis.y(mark))))
            }
            for x in verticals {
                grid.move(to: CGPoint(x: x, y: y(10)))
                grid.addLine(to: CGPoint(x: x, y: y(78)))
            }
            context.stroke(grid, with: .color(.secondary.opacity(0.45)), style: StrokeStyle(lineWidth: 1, dash: [2, 3]))

            let point = { (p: [Double]) in CGPoint(x: p[0] / 300 * size.width, y: y(p[1] * axis.scale + axis.offset)) }
            let shading = GraphicsContext.Shading.linearGradient(Gradient(stops: stops), startPoint: .zero, endPoint: CGPoint(x: size.width, y: 0))
            for run in profile.runs where !run.isEmpty {
                var line = Path()
                line.move(to: point(run[0]))
                for p in run.dropFirst() { line.addLine(to: point(p)) }
                var area = line
                area.addLine(to: CGPoint(x: point(run[run.count - 1]).x, y: y(78)))
                area.addLine(to: CGPoint(x: point(run[0]).x, y: y(78)))
                area.closeSubpath()
                context.opacity = 0.16
                context.fill(area, with: shading)
                context.opacity = 1
                context.stroke(line, with: shading, style: StrokeStyle(lineWidth: 2.5, lineCap: .round, lineJoin: .round))
            }
        }
    }

    /// Hard stops at each colour's start, so the colours meet without blending.
    private var stops: [Gradient.Stop] {
        let runs = profile.colors.compactMap { $0.count == 2 ? (from: $0[0], band: Int($0[1])) : nil }
        guard !runs.isEmpty else { return [.init(color: Profile.bands[0], location: 0), .init(color: Profile.bands[0], location: 1)] }
        return runs.enumerated().flatMap { i, run in
            let color = Profile.bands[min(max(run.band, 0), 3)]
            let end = i + 1 < runs.count ? runs[i + 1].from : 1
            return [Gradient.Stop(color: color, location: run.from), Gradient.Stop(color: color, location: end)]
        }
    }
}

/// The colour key, as the planner's `SlopeScale`: "Steigung in %" over the four bands with 3, 8 and 15 between them.
struct SlopeScale: View {
    @ScaledMetric(relativeTo: .caption2) private var width: CGFloat = 96
    @ScaledMetric(relativeTo: .caption2) private var marks: CGFloat = 12

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("Steigung in %").font(.caption2).foregroundStyle(.secondary)
            HStack(spacing: 2) {
                ForEach(Profile.bands.indices, id: \.self) { Profile.bands[$0].frame(height: 5) }
            }
            .clipShape(Capsule())
            GeometryReader { size in
                ForEach(Array(["3", "8", "15"].enumerated()), id: \.offset) { i, mark in
                    Text(mark).font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                        .fixedSize()
                        .position(x: size.size.width * CGFloat(i + 1) / 4, y: marks / 2)
                }
            }
            .frame(height: marks)
        }
        .frame(width: width)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Linienfarbe nach Steigung: unter 3 %, 3 bis 8 %, 8 bis 15 %, ab 15 %")
    }
}
