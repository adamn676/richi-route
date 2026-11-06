import MapLibre
import Network
import SwiftUI

/// The map under the route, as the planner's choice of maps: the offline map, or online aerial photos (basemap.at,
/// with the offline map's names over them) or OpenTopoMap's terrain map.
enum Basemap: String, CaseIterable {
    case map, aerial, terrain

    var label: String {
        switch self {
        case .map: "Karte"
        case .aerial: "Satellit"
        case .terrain: "Gelände"
        }
    }

    var symbol: String {
        switch self {
        case .map: "map"
        case .aerial: "globe.europe.africa.fill"
        case .terrain: "mountain.2.fill"
        }
    }

    /// The online tiles, none for the offline map.
    var tiles: [String] {
        switch self {
        case .map: []
        case .aerial: ["https://mapsneu.wien.gv.at/basemap/bmaporthofoto30cm/normal/google3857/{z}/{y}/{x}.jpeg"]
        case .terrain: ["a", "b", "c"].map { "https://\($0).tile.opentopomap.org/{z}/{x}/{y}.png" }
        }
    }

    var maximumZoom: Int { self == .terrain ? 17 : 19 }

    /// Where its tiles are: basemap.at's photos cover Austria (`basemaps.ts`).
    var bounds: MLNCoordinateBounds? {
        self == .aerial ? MLNCoordinateBounds(sw: CLLocationCoordinate2D(latitude: 46.36, longitude: 8.78),
                                              ne: CLLocationCoordinate2D(latitude: 49.04, longitude: 17.5)) : nil
    }

    /// Its credit, as the planner gives it.
    var credit: String? {
        switch self {
        case .map: nil
        case .aerial: "Grundkarte: basemap.at"
        case .terrain: "Kartendarstellung: © OpenTopoMap (CC-BY-SA) · SRTM"
        }
    }

    /// The signed cycle routes over any map (Waymarked Trails), as the planner's "Radrouten".
    static let cycleRoutes = "https://tile.waymarkedtrails.org/cycling/{z}/{x}/{y}.png"
    static let cycleRoutesCredit = "Radrouten: Waymarked Trails (CC BY-SA)"

    /// The keys the choice is kept under, from one opening to the next.
    static let key = "basemap", cycleRoutesKey = "cycleRoutes"
}

/// Whether the phone is online, for what only shows with the internet: one watch for the app.
@MainActor @Observable
final class Connection {
    static let shared = Connection()
    private(set) var online = true
    private let monitor = NWPathMonitor()

    private init() {
        monitor.pathUpdateHandler = { [weak self] path in
            Task { @MainActor in self?.online = path.status == .satisfied }
        }
        monitor.start(queue: .main)
    }
}

/// The choice of map, as Apple Maps' map card: the base map, and the signed cycle routes over it; what needs the
/// internet waits for it.
struct MapChooser: View {
    @Binding var basemap: Basemap
    @Binding var cycleRoutes: Bool
    let online: Bool
    let close: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Karte").font(.headline).foregroundStyle(Color.ink)
                Spacer()
                CloseButton(label: "Karte schließen", action: close)
            }
            HStack(spacing: 8) {
                ForEach(Basemap.allCases, id: \.self) { choice in
                    Button { basemap = choice } label: {
                        VStack(spacing: 6) {
                            Image(systemName: choice.symbol).font(.title2).frame(height: 30)
                            Text(choice.label).font(.footnote.weight(.medium))
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                        .foregroundStyle(basemap == choice ? Color.ink : .secondary)
                        .background {
                            RoundedRectangle(cornerRadius: 12)
                                .strokeBorder(basemap == choice ? Color.ink : Color.secondary.opacity(0.3), lineWidth: basemap == choice ? 2 : 1)
                        }
                        .contentShape(RoundedRectangle(cornerRadius: 12))
                    }
                    .buttonStyle(.plain)
                    .disabled(!choice.tiles.isEmpty && !online)
                    .accessibilityAddTraits(basemap == choice ? .isSelected : [])
                }
            }
            // iOS's own green: the ink, light in Dark Mode, would hide the white knob
            Toggle("Radrouten", isOn: $cycleRoutes).tint(.green).disabled(!online)
            if !online {
                Text("Satellit, Gelände und Radrouten nur mit Internet.").font(.footnote).foregroundStyle(.secondary)
            }
        }
        .padding(16)
        .frame(width: 300)
        .tint(Color.ink)
        .glass(in: RoundedRectangle(cornerRadius: 24))
        // a tap on the card stays on it, never reaching the map below
        .contentShape(RoundedRectangle(cornerRadius: 24))
        .onTapGesture {}
    }
}
