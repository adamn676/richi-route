import SwiftUI

/// The planner: the map, its buttons, and the route in a panel over it that the rider pulls up.
struct PlannerView: View {
    static let peek: CGFloat = 290

    @State private var planner = Planner()
    @State private var detent = PresentationDetent.height(Self.peek)
    @State private var locating = 0

    var body: some View {
        GeometryReader { screen in
            PlannerMap(content: planner.mapContent, bottomInset: panelHeight(on: screen.size.height), locating: locating) { coord, leg in
                if let leg, planner.picking == nil { planner.insert(coord, onLeg: leg) } else { planner.place(coord) }
            } move: { stop, coord in
                planner.move(stop, to: coord)
            } moved: { center in
                planner.focus = center
            }
        }
        .ignoresSafeArea()
        .overlay(alignment: .top) {
            if let picking = planner.picking, let index = planner.stops.firstIndex(where: { $0.id == picking }) {
                PickHint(text: Self.pickText(at: index, of: planner.stops.count), cancel: planner.cancelPick)
                    .padding(.leading, 16)
                    .padding(.trailing, 72)
                    .padding(.top, 8)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .animation(.easeOut(duration: 0.2), value: planner.picking)
        .overlay(alignment: .top) {
            if let notice = planner.notice {
                NoticeBar(notice: notice, restore: { planner.replace(with: notice.restore) }, dismiss: planner.dismissNotice)
                    .padding(.leading, 16)
                    .padding(.trailing, 72)
                    .padding(.top, 8)
                    .transition(.move(edge: .top).combined(with: .opacity))
                    .id(notice.id)
            }
        }
        .animation(.easeOut(duration: 0.2), value: planner.notice)
        .overlay(alignment: .topTrailing) {
            VStack(spacing: 12) {
                if !planner.routedLegs.isEmpty {
                    MapButton(label: "Auf Route zoomen", symbol: "viewfinder") { planner.frame() }
                }
                MapButton(label: "Mein Standort", symbol: "location") { locating += 1 }
            }
            .padding(.trailing, 16)
            .padding(.top, 8)
        }
        .sheet(isPresented: .constant(true)) {
            RouteSheet(planner: planner, folded: detent == .height(Self.peek)) { detent = .height(Self.peek) }
                // no full height: iOS swaps the glass for white there, abruptly
                .presentationDetents([.height(Self.peek), .medium, .fraction(0.9)], selection: $detent)
                .presentationBackgroundInteraction(.enabled(upThrough: .fraction(0.9)))
                .interactiveDismissDisabled()
        }
        .task { await planner.start() }
        // sparing, as Apple advises: the rider's own edits, a long wait ended, and what went wrong
        .sensoryFeedback(trigger: planner.feedback) { _, feedback in
            switch feedback.kind {
            case .tap: .impact(weight: .light)
            case .done: .success
            case .warning: .warning
            }
        }
    }
}

extension PlannerView {
    static func pickText(at index: Int, of count: Int) -> String {
        index == 0 ? "Neuen Start antippen" : index == count - 1 ? "Neues Ziel antippen" : "Neuen Zwischenstopp \(index) antippen"
    }

    /// How much of the map the panel covers at its height, which framing the route leaves free.
    func panelHeight(on screen: CGFloat) -> CGFloat {
        switch detent {
        case .medium: screen / 2
        case .fraction(0.9): screen * 0.9
        default: Self.peek
        }
    }
}

/// A confirmation over the map, gone after a few seconds, longer with its one action (as the planner's snackbars).
struct NoticeBar: View {
    let notice: Notice
    let restore: () -> Void
    let dismiss: () -> Void

    var body: some View {
        HStack(spacing: 4) {
            Text(notice.text).font(.subheadline).padding(.leading, 16).padding(.vertical, 12)
            Spacer(minLength: 0)
            if notice.restore != nil {
                Button("Wiederherstellen", action: restore)
                    .font(.subheadline.weight(.semibold))
                    .frame(minHeight: 44)
                    .padding(.horizontal, 14)
            }
        }
        .foregroundStyle(Color(MapStyle.ink))
        .glass(in: Capsule())
        .task(id: notice.id) {
            try? await Task.sleep(for: .seconds(notice.restore == nil ? 4 : 8))
            if !Task.isCancelled { dismiss() }
        }
    }
}

/// What a tap on the map does now, with the way out.
struct PickHint: View {
    let text: String
    let cancel: () -> Void

    var body: some View {
        HStack(spacing: 4) {
            Text(text).font(.subheadline).padding(.leading, 16).padding(.vertical, 10)
            Spacer(minLength: 0)
            Button("Abbrechen", action: cancel)
                .font(.subheadline.weight(.semibold))
                .frame(minHeight: 44)
                .padding(.horizontal, 14)
        }
        .foregroundStyle(Color(MapStyle.ink))
        .glass(in: Capsule())
    }
}

/// A round button over the map, as the planner's map buttons.
struct MapButton: View {
    let label: String
    let symbol: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 18, weight: .medium))
                .frame(width: 44, height: 44)
                .contentShape(Circle())
        }
        .foregroundStyle(Color(MapStyle.ink))
        .glass(in: Circle())
        .accessibilityLabel(label)
    }
}

extension View {
    /// iOS 26's Liquid Glass, as the panel has, for controls over the map; frosted material before.
    @ViewBuilder func glass(in shape: some Shape) -> some View {
        if #available(iOS 26, *) {
            glassEffect(.regular.interactive(), in: shape)
        } else {
            background(.regularMaterial, in: shape).shadow(color: .black.opacity(0.2), radius: 4, y: 1)
        }
    }
}
