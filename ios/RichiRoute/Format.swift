import Foundation

/// The planner's number formats (`src/utils/format.ts`): German, a dot between thousands and a comma before
/// decimals, also where the phone is set to Austrian German, which groups with a space.
enum Format {
    private static let german = Locale(identifier: "de_DE")

    /// Kilometres with up to `digits` decimals.
    static func km(_ meters: Double, digits: Int = 1) -> String {
        (meters / 1000).formatted(.number.locale(german).precision(.fractionLength(0...digits)))
    }

    /// A length in metres under a kilometre, else in kilometres with one decimal (`formatLength`).
    static func length(_ meters: Double) -> String {
        meters < 1 ? "< 1 m" : meters < 1000 ? "\(Int(meters.rounded())) m" : "\(km(meters)) km"
    }

    static func whole(_ value: Double) -> String {
        value.formatted(.number.locale(german).precision(.fractionLength(0)))
    }

    /// A gradient in percent, signed, up to one decimal: +4,5 or -2 (`formatGradient`).
    static func gradient(_ percent: Double) -> String {
        percent.formatted(.number.locale(german).precision(.fractionLength(0...1)).sign(strategy: .always(includingZero: false)))
    }

    /// A point without an address, as the planner's stop fields show it.
    static func coordinate(_ coord: [Double]) -> String {
        String(format: "%.5f° N, %.5f° E", coord[1], coord[0])
    }
}
