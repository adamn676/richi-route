import SwiftUI

/// "Runden vorschlagen": a distance and climbing, each set with its slider or typed, then suggested on request; the
/// settings then fold into one line, so the three loops fit beside the map, the chosen one strong on it; "Fahren" takes
/// one as the route.
struct LoopsView: View {
    let planner: Planner
    let loops: Loops

    var body: some View {
        Section {
            HStack {
                Text("Runde ab \(start)").font(.headline).foregroundStyle(Color.ink).lineLimit(1)
                Spacer()
                CloseButton(label: "Runden schließen", action: planner.closeLoops)
            }
            .listRowSeparator(.hidden)
            if loops.editing {
                LoopSetting(label: "Distanz", unit: "km", steps: Loops.kilometreSteps, value: loops.kilometres) { planner.loops?.kilometres = $0 }
                    .listRowSeparator(.hidden)
                LoopSetting(label: "Höhenmeter", unit: "hm", steps: Loops.ascentSteps, value: loops.ascent) { planner.loops?.ascent = $0 }
                    .listRowSeparator(.hidden)
                Button(action: planner.suggestLoops) {
                    Text("Runden vorschlagen").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .tint(Color.ink)
                .foregroundStyle(Color.onInk)
            } else {
                Button { planner.loops?.editing = true } label: {
                    HStack {
                        Text("\(Format.whole(Double(loops.kilometres))) km · \(Format.whole(Double(loops.ascent))) hm").monospacedDigit()
                        Spacer()
                        Text("Ändern").foregroundStyle(Color.ink)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        if let result = loops.result {
            Section {
                switch result {
                case .searching:
                    HStack(spacing: 12) {
                        ProgressView()
                        Text("Runden werden gesucht …").foregroundStyle(.secondary)
                    }
                case .failed(let message): Text(message).foregroundStyle(.secondary)
                case .found(let found) where found.isEmpty:
                    Text("Von hier ließ sich keine Runde auf befestigten Straßen finden. Etwas kürzer probieren?").foregroundStyle(.secondary)
                case .found(let found):
                    ForEach(found.indices, id: \.self) { index in row(found[index], at: index) }
                    // under all three, which stay beside the map at half height
                    preview(found[loops.chosen])
                }
            }
        }
    }

    /// The chosen loop's surfaces, then its profile, which points on the map.
    @ViewBuilder private func preview(_ found: Loops.Found) -> some View {
        if found.surfaces != nil || found.profile != nil {
            VStack(alignment: .leading, spacing: 12) {
                if let surfaces = found.surfaces {
                    // the rows below say it all to VoiceOver
                    SurfaceBar(surfaces: surfaces).accessibilityHidden(true)
                    // which colour is which, as the route's "Untergrund"; its sections open once it is the route
                    ForEach(surfaces.totals, id: \.surface) { SurfaceTotal(total: $0, surfaces: surfaces) }
                }
                if let profile = found.profile {
                    ElevationProfile(profile: profile, legs: [found.loop.leg]) { planner.showPoint($0?.coordinate) }
                }
            }
            .padding(.vertical, 4)
        }
    }

    private var start: String { planner.stops.first?.coord.flatMap { planner.names[$0] }.map(Planner.place) ?? "Start" }

    /// A loop as Apple Maps' route cards: its figures, under them where it goes; a tap shows it strong on the map,
    /// "Fahren" takes it, as Apple Maps' "Los".
    private func row(_ found: Loops.Found, at index: Int) -> some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text(found.figures).font(.subheadline.weight(.semibold)).monospacedDigit()
                Text(found.name + (found.loop.back ? ", hin und zurück" : ""))
                    .font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 0)
            Button("Fahren") { planner.takeLoop(index) }
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.capsule)
                .controlSize(.small)
                .tint(Color.ink)
                .foregroundStyle(Color.onInk)
        }
        .contentShape(Rectangle())
        .onTapGesture { planner.chooseLoop(index) }
        .listRowBackground(index == loops.chosen ? Color.ink.opacity(0.08) : nil)
        .accessibilityAddTraits(index == loops.chosen ? .isSelected : [])
    }
}

/// A figure set with a slider in the planner's steps or typed (as on the web planner): a tap anywhere on its line
/// selects the figure to type over; a typed one is brought into its range.
private struct LoopSetting: View {
    let label: String
    let unit: String
    let steps: [Int]
    let value: Int
    let set: (Int) -> Void
    @State private var typed = ""
    @FocusState private var typing: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text(label).font(.subheadline).foregroundStyle(.secondary)
                Spacer()
                TextField(label, text: $typed)
                    .keyboardType(.numbersAndPunctuation)
                    .submitLabel(.done)
                    .multilineTextAlignment(.trailing)
                    .font(.headline.monospacedDigit())
                    .fixedSize()
                    .focused($typing)
                Text(unit).font(.subheadline).foregroundStyle(.secondary)
            }
            .contentShape(Rectangle())
            .onTapGesture { typing = true }
            Slider(value: Binding(get: { Double(nearest(value)) }, set: { set(steps[Int($0.rounded())]) }),
                   in: 0...Double(steps.count - 1), step: 1)
                .tint(Color.track)
                // a tick at each step, as iOS's pickers
                .sensoryFeedback(.selection, trigger: value) { _, _ in !typing }
                .accessibilityLabel(label)
                .accessibilityValue("\(Format.whole(Double(value))) \(unit)")
        }
        // a figure typed counts at once, so "Runden vorschlagen" right after takes it; brought into range when the typing
        // ends
        .onAppear { typed = Format.whole(Double(value)) }
        .onChange(of: value) { if !typing { typed = Format.whole(Double(value)) } }
        .onChange(of: typed) {
            if let figure = Int(typed.filter(\.isNumber)), steps[0]...steps[steps.count - 1] ~= figure { set(figure) }
        }
        .onChange(of: typing) {
            if typing {
                // the figure selected, so what is typed replaces it
                DispatchQueue.main.async { UIApplication.shared.sendAction(#selector(UIResponder.selectAll(_:)), to: nil, from: nil, for: nil) }
            } else {
                let figure = Int(typed.filter(\.isNumber)) ?? value
                set(min(max(figure, steps[0]), steps[steps.count - 1]))
                typed = Format.whole(Double(min(max(figure, steps[0]), steps[steps.count - 1])))
            }
        }
    }

    /// The slider's place nearest a figure.
    private func nearest(_ figure: Int) -> Int {
        steps.indices.min { abs(steps[$0] - figure) < abs(steps[$1] - figure) } ?? 0
    }
}
