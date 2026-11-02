import SwiftUI

/// The route's elevation profile as the engine's `/profile` draws it (`engine/planner/src/profile.rs`): x from 0 to
/// 300, y from 10 (highest) to 78 (lowest), and colour runs by the steepest climb held in each stretch.
struct Profile: Decodable, Equatable, Sendable {
    let distance: Double
    let minimum: Double
    let maximum: Double
    let runs: [[[Double]]]
    /// Where each colour starts (0 to 1 along the route) and its band, < 3 %, 3 to 8 %, 8 to 15 %, ≥ 15 %.
    let colors: [[Double]]

    /// The planner's colours of the bands (`gradientBands`, `src/domain/gpx-inspection.ts`).
    static let bands = [
        Color(red: 0x35 / 255, green: 0x9a / 255, blue: 0x78 / 255),
        Color(red: 0xd4 / 255, green: 0xa1 / 255, blue: 0x26 / 255),
        Color(red: 0xd5 / 255, green: 0x6b / 255, blue: 0x31 / 255),
        Color(red: 0xb9 / 255, green: 0x36 / 255, blue: 0x4f / 255),
    ]
}

/// The profile with its gradient colours, its heights and length, and the colour key.
struct ElevationProfile: View {
    let profile: Profile

    private static let chartHeight: CGFloat = 96

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top, spacing: 8) {
                chart
                VStack(alignment: .trailing) {
                    Text("\(Format.whole(profile.maximum)) m")
                    Spacer()
                    Text("\(Format.whole(profile.minimum)) m")
                }
                .font(.caption2.monospacedDigit())
                .foregroundStyle(.secondary)
                .frame(height: Self.chartHeight * 68 / 88 + 12)
                .padding(.top, Self.chartHeight * 10 / 88 - 6)
            }
            HStack(alignment: .firstTextBaseline) {
                Text("0 km").font(.caption2).foregroundStyle(.secondary)
                Spacer()
                SlopeScale()
                Spacer()
                Text("\(Format.km(profile.distance)) km").font(.caption2).foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Höhenprofil von \(Format.whole(profile.minimum)) bis \(Format.whole(profile.maximum)) m über \(Format.km(profile.distance)) km")
    }

    private var chart: some View {
        Canvas { context, size in
            let point = { (p: [Double]) in CGPoint(x: p[0] / 300 * size.width, y: p[1] / 88 * size.height) }
            let shading = GraphicsContext.Shading.linearGradient(
                Gradient(stops: stops), startPoint: .zero, endPoint: CGPoint(x: size.width, y: 0))
            for run in profile.runs where !run.isEmpty {
                var line = Path()
                line.move(to: point(run[0]))
                for p in run.dropFirst() { line.addLine(to: point(p)) }
                var area = line
                area.addLine(to: CGPoint(x: point(run[run.count - 1]).x, y: size.height))
                area.addLine(to: CGPoint(x: point(run[0]).x, y: size.height))
                area.closeSubpath()
                context.opacity = 0.16
                context.fill(area, with: shading)
                context.opacity = 1
                context.stroke(line, with: shading, style: StrokeStyle(lineWidth: 2.5, lineCap: .round, lineJoin: .round))
            }
        }
        .frame(height: Self.chartHeight)
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
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("Steigung in %").font(.caption2).foregroundStyle(.secondary)
            HStack(spacing: 2) {
                ForEach(Profile.bands.indices, id: \.self) { Profile.bands[$0].frame(height: 5) }
            }
            .clipShape(Capsule())
            GeometryReader { size in
                ForEach(Array(["3", "8", "15"].enumerated()), id: \.offset) { i, mark in
                    Text(mark).font(.system(size: 10).monospacedDigit()).foregroundStyle(.secondary)
                        .fixedSize()
                        .position(x: size.size.width * CGFloat(i + 1) / 4, y: 6)
                }
            }
            .frame(height: 12)
        }
        .frame(width: 96)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Linienfarbe nach Steigung: unter 3 %, 3 bis 8 %, 8 bis 15 %, ab 15 %")
    }
}
