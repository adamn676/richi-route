import SwiftUI

/// The route's surfaces as the engine's `/surfaces` lists them (`engine/planner/src/surfaces.rs`): the metres of each
/// group, and its sections, each running on across the legs' ends.
struct Surfaces: Decodable, Equatable, Sendable {
    struct Total: Decodable, Equatable, Sendable {
        let surface: Surface
        let meters: Double
    }

    struct Section: Decodable, Equatable, Sendable {
        let from: Double
        let to: Double
        let surface: Surface
        let corrected: Bool
        /// `[leg, from, to]`: the points it covers on each leg.
        let parts: [[Int]]

        var range: ClosedRange<Double> { from...to }

        func line(on legs: [Leg]) -> [[Double]] { parts.flatMap { legs[$0[0]].coordinates[$0[1]...$0[2]] } }
    }

    let distance: Double
    let totals: [Total]
    let sections: [Section]

    /// A share of the route as the planner shows it: under 1 % as "< 1 %".
    func share(_ meters: Double) -> String {
        let percent = distance > 0 ? meters / distance * 100 : 0
        return percent < 1 ? "< 1 %" : "\(Int(percent.rounded())) %"
    }
}

/// The surface groups, each a row that opens its sections beneath it, as a disclosure does; opening one shows its
/// first section on the map, the arrows step through them, round to the first again (the planner's `SurfaceDetails`).
struct SurfaceRows: View {
    let surfaces: Surfaces
    let legs: [Leg]
    /// The section the map shows.
    let focused: ClosedRange<Double>?
    let focus: (_ range: ClosedRange<Double>?, _ line: [[Double]]) -> Void

    @State private var open: Surface?
    @State private var shown = 10

    static let stepRow = "surface-step"

    var body: some View {
        ForEach(surfaces.totals, id: \.surface) { total in
            totalRow(total)
            if open == total.surface { sectionRows(surfaces.sections.filter { $0.surface == total.surface }) }
        }
        .onChange(of: surfaces) {
            if !surfaces.totals.contains(where: { $0.surface == open }) { open = nil }
            shown = 10
        }
    }

    private func totalRow(_ total: Surfaces.Total) -> some View {
        let isOpen = open == total.surface
        return Button {
            if isOpen {
                open = nil
                focus(nil, [])
            } else {
                open = total.surface
                shown = 10
                if let first = surfaces.sections.first(where: { $0.surface == total.surface }) { show(first) }
            }
        } label: {
            HStack(spacing: 10) {
                Circle().fill(Color(MapStyle.shared.color(total.surface))).frame(width: 10, height: 10)
                Text(total.surface.label).foregroundStyle(.primary)
                Spacer()
                Text(Format.length(total.meters)).foregroundStyle(.primary)
                Text(surfaces.share(total.meters)).foregroundStyle(.secondary).frame(width: 44, alignment: .trailing)
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.tertiary)
                    .rotationEffect(.degrees(isOpen ? 90 : 0))
            }
            .font(.subheadline)
            .contentShape(Rectangle())
        }
        .animation(.easeOut(duration: 0.2), value: isOpen)
        .accessibilityAddTraits(isOpen ? .isSelected : [])
        .accessibilityHint(isOpen ? "Schließt die Abschnitte" : "Zeigt die Abschnitte auf der Karte")
    }

    @ViewBuilder
    private func sectionRows(_ matching: [Surfaces.Section]) -> some View {
        let position = matching.firstIndex { $0.range == focused }
        HStack(spacing: 0) {
            // which surface, as the row it opened from may be scrolled away
            Text("\(matching[0].surface.label) · " + (position.map { matching.count > 1 ? "\($0 + 1) von \(matching.count)" : "1 Abschnitt" }
                 ?? (matching.count == 1 ? "1 Abschnitt" : "\(matching.count) Abschnitte")))
                .font(.footnote.monospacedDigit())
                .foregroundStyle(.secondary)
            Spacer()
            if matching.count > 1 {
                stepButton("chevron.left", "Voriger Abschnitt") { step(by: -1, in: matching, from: position) }
                stepButton("chevron.right", "Nächster Abschnitt") { step(by: 1, in: matching, from: position) }
                    .padding(.trailing, -12)
            }
        }
        .padding(.leading, 20)
        .frame(minHeight: 44)
        .id(Self.stepRow)
        ForEach(matching.prefix(shown), id: \.from) { section in
            let isFocused = section.range == focused
            Button {
                if isFocused { focus(nil, []) } else { show(section) }
            } label: {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("km \(Format.km(section.from, digits: 2, fixed: true)) bis \(Format.km(section.to, digits: 2, fixed: true))")
                        if section.corrected { Text("korrigiert").font(.caption).foregroundStyle(.secondary) }
                    }
                    Spacer()
                    Text(Format.length(section.to - section.from))
                }
                .font(.subheadline.monospacedDigit())
                .fontWeight(isFocused ? .semibold : .regular)
                .foregroundStyle(.primary)
                .padding(.leading, 20)
                .contentShape(Rectangle())
            }
            .listRowBackground(isFocused ? Color.ink.opacity(0.08) : nil)
            .accessibilityAddTraits(isFocused ? .isSelected : [])
        }
        if matching.count > shown {
            Button("Weitere Abschnitte") { shown += 10 }
                .font(.subheadline)
                .padding(.leading, 20)
        }
    }

    private func stepButton(_ symbol: String, _ label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.body.weight(.medium))
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
        .accessibilityLabel(label)
    }

    /// The next or previous section, from the last round to the first; the list grows to show it.
    private func step(by offset: Int, in matching: [Surfaces.Section], from position: Int?) {
        let count = matching.count
        let next = position.map { ($0 + offset + count) % count } ?? (offset > 0 ? 0 : count - 1)
        shown = max(shown, (next / 10 + 1) * 10)
        show(matching[next])
    }

    private func show(_ section: Surfaces.Section) { focus(section.range, section.line(on: legs)) }
}
