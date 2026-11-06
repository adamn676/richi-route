import MapKit
import SwiftUI

/// The planner: the map, its buttons, and the route in a panel over it that the rider pulls up.
struct PlannerView: View {
    static let peek: CGFloat = 290

    @State private var planner = Planner()
    @State private var detent = PresentationDetent.height(Self.peek)
    @State private var locating = 0
    @State private var offMap = false
    @AppStorage(Basemap.key) private var basemap = Basemap.map
    @AppStorage(Basemap.cycleRoutesKey) private var cycleRoutes = false
    @State private var choosingMap = false
    /// Where Street View was asked for, and Apple's Look Around shown full screen or Google's in its card.
    @State private var pin: LookPin?
    @State private var pickingStreetView = false
    @State private var lookup: Task<Void, Never>?
    @State private var lookAround: MKLookAroundScene?
    @State private var looking: [Double]?
    private let connection = Connection.shared

    /// What the map shows of the choice: what needs the internet waits for it.
    private var shown: (basemap: Basemap, cycleRoutes: Bool) { connection.online ? (basemap, cycleRoutes) : (.map, false) }
    /// The online maps' credits, clearly in view on the map as their terms ask.
    private var onlineCredits: [String] { [shown.basemap.credit, shown.cycleRoutes ? Basemap.cycleRoutesCredit : nil].compactMap { $0 } }

    var body: some View {
        GeometryReader { screen in
            PlannerMap(content: planner.mapContent, bottomInset: panelHeight(on: screen.size.height), locating: locating,
                       basemap: shown.basemap, cycleRoutes: shown.cycleRoutes, pin: pin, pickingStreetView: pickingStreetView) { coord, leg in
                if let leg, planner.picking == nil { planner.insert(coord, onLeg: leg) } else { planner.place(coord) }
            } move: { stop, coord in
                planner.move(stop, to: coord)
            } shape: { coord, leg in
                planner.shape(coord, onLeg: leg)
            } moved: { center in
                planner.focus = center
            } pointer: { show in
                planner.showPoint = show
            } covered: { covered in
                offMap = !covered
            } chooseLoop: { planner.chooseLoop($0) } look: { coord in
                look(at: coord)
            }
        }
        .ignoresSafeArea()
        .overlay(alignment: .top) {
            if pickingStreetView {
                PickHint(text: "Street View: Ort antippen") { pickingStreetView = false }
                    .padding(.leading, 16)
                    .padding(.trailing, 72)
                    .padding(.top, 8)
                    .transition(.move(edge: .top).combined(with: .opacity))
            } else if let picking = planner.picking {
                // a stop not on the route yet is a new Zwischenstopp, before the Ziel
                let shown = planner.waypoints, index = shown.firstIndex { $0.id == picking }
                PickHint(text: Self.pickText(at: index ?? shown.count - 1, of: shown.count + (index == nil ? 1 : 0)), cancel: planner.cancelPick)
                    .padding(.leading, 16)
                    .padding(.trailing, 72)
                    .padding(.top, 8)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .animation(.easeOut(duration: 0.2), value: planner.picking)
        .animation(.easeOut(duration: 0.2), value: pickingStreetView)
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
        // where the phone has no map, a word why the map is empty, unless something more pressing is shown there
        .overlay(alignment: .top) {
            if offMap && planner.picking == nil && planner.notice == nil {
                Label("Keine Offline-Karte für dieses Gebiet", systemImage: "map")
                    .font(.subheadline)
                    .foregroundStyle(Color.ink)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                    .glass(in: Capsule())
                    .padding(.leading, 16)
                    .padding(.trailing, 72)
                    .padding(.top, 8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .transition(.opacity)
            }
        }
        .animation(.easeOut(duration: 0.2), value: offMap)
        .overlay(alignment: .topTrailing) {
            VStack(spacing: 12) {
                if !planner.routedLegs.isEmpty {
                    MapButton(label: "Auf Route zoomen", symbol: "viewfinder") { planner.frame(whole: true) }
                }
                MapButton(label: "Karte wählen", symbol: "map") { choosingMap.toggle() }
                MapButton(label: "Mein Standort", symbol: "location") { locating += 1 }
                // as on the planner, only with the internet
                if connection.online {
                    MapButton(label: "Street View", symbol: "binoculars", active: pickingStreetView) {
                        pickingStreetView.toggle()
                        choosingMap = false
                    }
                }
                // each only while it can do something; redo keeps its place under undo
                if planner.canUndo || planner.canRedo {
                    MapButton(label: "Rückgängig", symbol: "arrow.uturn.backward", action: planner.undo).shown(planner.canUndo)
                    MapButton(label: "Wiederholen", symbol: "arrow.uturn.forward", action: planner.redo).shown(planner.canRedo)
                }
            }
            .animation(.easeOut(duration: 0.2), value: [planner.canUndo, planner.canRedo])
            .padding(.trailing, 16)
            .padding(.top, 8)
        }
        // the online maps' credits, clearly in view as their terms ask; the hint for picking a point takes their place
        .overlay(alignment: .topLeading) {
            if !onlineCredits.isEmpty && planner.picking == nil && looking == nil {
                Text(onlineCredits.joined(separator: "\n"))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .glass(in: RoundedRectangle(cornerRadius: 8))
                    .padding(.leading, 16)
                    .padding(.trailing, 72)
                    .padding(.top, 8)
            }
        }
        .overlay(alignment: .topTrailing) {
            if choosingMap {
                MapChooser(basemap: $basemap, cycleRoutes: $cycleRoutes, online: connection.online) { choosingMap = false }
                    .padding(.trailing, 72)
                    .padding(.top, 8)
                    .transition(.opacity.combined(with: .scale(scale: 0.95, anchor: .topTrailing)))
            }
        }
        .animation(.easeOut(duration: 0.2), value: choosingMap)
        .overlay(alignment: .top) {
            if let looking {
                StreetView(coordinate: looking) { self.looking = nil }
                    .id(looking)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .animation(.easeOut(duration: 0.25), value: looking)
        .sheet(isPresented: .constant(true)) {
            RouteSheet(planner: planner, folded: detent == .height(Self.peek),
                       credits: (["© OpenStreetMap · Österr. Adressregister"] + onlineCredits).joined(separator: " · ")) {
                detent = .height(Self.peek)
            } halve: {
                detent = .medium
            }
                // no full height: iOS swaps the glass for white there, abruptly
                .presentationDetents([.height(Self.peek), .medium, .fraction(0.9)], selection: $detent)
                .presentationBackgroundInteraction(.enabled(upThrough: .fraction(0.9)))
                .interactiveDismissDisabled()
                // shown from the panel, which is already presented over the map
                .lookAroundViewer(isPresented: Binding { lookAround != nil } set: { if !$0 { lookAround = nil } },
                                  initialScene: lookAround)
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
    /// Street View at a tapped spot, a pin dropped there: Apple's Look Around full screen, else Google's in its card;
    /// where neither has any, the pin says so and goes. None clears the pin and Google's card.
    private func look(at coord: [Double]?) {
        lookup?.cancel()
        (pickingStreetView, choosingMap, looking) = (false, false, nil)
        pin = coord.map { LookPin(coordinate: $0) }
        guard let coord else { return }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        lookup = Task {
            let imagery = await StreetView.imagery(at: coord)
            guard !Task.isCancelled else { return }
            switch imagery {
            case .apple(let scene):
                pin?.state = .found
                lookAround = scene
            case .google(let at):
                pin?.state = .found
                looking = at
            case nil:
                pin?.state = .missing(connection.online ? "Kein Street View hier" : "Street View braucht Internet")
                try? await Task.sleep(for: .seconds(2))
                if !Task.isCancelled { pin = nil }
            }
        }
    }

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
        .foregroundStyle(Color.ink)
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
        .foregroundStyle(Color.ink)
        .glass(in: Capsule())
    }
}

/// The panel's one way to close what is open (the loops, a surface's sections, a stretch of the profile), the same
/// everywhere: the whole route shows again.
struct CloseButton: View {
    let label: String
    /// Over a photo, on a blurred backing, so it stays in sight.
    var onImage = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            // the system's grey, not the tint's shade
            Image(systemName: "xmark.circle.fill").font(.title2).symbolRenderingMode(.hierarchical).foregroundStyle(Color.secondary)
                .background { if onImage { Circle().fill(.regularMaterial) } }
                .frame(width: 44, height: 44).contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
        .padding(.trailing, -12)
        .accessibilityLabel(label)
    }
}

/// A round button over the map, as the planner's map buttons.
struct MapButton: View {
    let label: String
    let symbol: String
    /// On, as a mode the next tap on the map belongs to: drawn in ink.
    var active = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: active ? symbol + ".fill" : symbol)
                .font(.system(size: 18, weight: .medium))
                .frame(width: 44, height: 44)
                .contentShape(Circle())
        }
        .foregroundStyle(active ? Color.white : Color.ink)
        .background { if active { Circle().fill(Color(MapStyle.ink)) } }
        .glass(in: Circle())
        .accessibilityLabel(label)
        .accessibilityAddTraits(active ? .isSelected : [])
    }
}

extension View {
    /// Present, or out of sight and out of reach, keeping its place.
    func shown(_ shown: Bool) -> some View {
        opacity(shown ? 1 : 0).allowsHitTesting(shown).accessibilityHidden(!shown)
    }

    /// iOS 26's Liquid Glass, as the panel has, for controls over the map; frosted material before.
    @ViewBuilder func glass(in shape: some Shape) -> some View {
        if #available(iOS 26, *) {
            glassEffect(.regular.interactive(), in: shape)
        } else {
            background(.regularMaterial, in: shape).shadow(color: .black.opacity(0.2), radius: 4, y: 1)
        }
    }
}
