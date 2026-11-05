import CoreLocation
import SwiftUI

/// A suggestion as the engine's `/places` answers it (`engine/planner/src/place.rs`).
struct Place: Decodable, Identifiable, Sendable {
    let label: String
    let title: String
    let detail: String?
    let category: String
    let coord: [Double]
    /// The street of an address, whose own position lies off the street.
    let street: String?

    var id: String { "\(label)|\(coord)" }

    /// What it is, as a glyph: the planner's categories.
    var symbol: String {
        switch category {
        case "address": "house"
        case "street": "road.lanes"
        case "town": "building.2"
        case "mountain": "mountain.2"
        case "station": "tram"
        case "water": "drop"
        default: "mappin"
        }
    }
}

/// Where a stop goes: a search over the offline areas, the rider's position, or a tap on the map.
struct StopSearch: View {
    let title: String
    let engine: Engine?
    let near: [Double]?
    let choose: (_ coord: [Double], _ name: String?) -> Void
    let pickOnMap: () -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @FocusState private var typing: Bool
    @State private var places: [Place] = []
    @State private var searched = false
    @State private var locating = false
    @State private var locationFailed = false

    var body: some View {
        VStack(spacing: 0) {
            header
            List {
                if query.trimmingCharacters(in: .whitespaces).count < 3 {
                    Button { Task { await chooseLocation() } } label: {
                        Label(locating ? "Standort wird ermittelt …" : "Mein Standort", systemImage: "location.fill")
                    }
                    .disabled(locating)
                    if locationFailed {
                        Text("Der Standort ist nicht verfügbar. Bitte in den Einstellungen erlauben oder den Punkt auf der Karte setzen.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    Button {
                        dismiss()
                        pickOnMap()
                    } label: {
                        Label("Auf der Karte wählen", systemImage: "map")
                    }
                } else if searched && places.isEmpty {
                    Text("Keine Adresse gefunden. Der Punkt lässt sich auch auf der Karte setzen.")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(places) { place in
                        Button { Task { await choose(place) } } label: {
                            Label {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(place.title)
                                    if let detail = place.detail { Text(detail).font(.footnote).foregroundStyle(.secondary) }
                                }
                            } icon: {
                                Image(systemName: place.symbol)
                            }
                        }
                    }
                }
            }
            .listStyle(.plain)
            .tint(Color.ink)
            .foregroundStyle(Color.ink)
            // the areas' address indexes read while the rider types, so the first search answers at once
            .task { _ = try? await engine?.places("", near: nil) }
            // as the planner: from three letters, after a short pause in typing
            .task(id: query) {
                let typed = query.trimmingCharacters(in: .whitespaces)
                searched = false
                guard typed.count >= 3, let engine else { return places = [] }
                try? await Task.sleep(for: .milliseconds(350))
                guard !Task.isCancelled else { return }
                places = (try? await engine.places(typed, near: near)) ?? []
                searched = true
            }
        }
        .onAppear { typing = true }
    }

    /// The field and the way out in one row, with no bar behind them that would show while the screen closes.
    private var header: some View {
        HStack(spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                // the stop in the field itself, as the planner's placeholder
                TextField("\(title) suchen", text: $query)
                    .focused($typing)
                    .submitLabel(.search)
                    // as Enter in the planner: the first suggestion
                    .onSubmit { if let first = places.first { Task { await choose(first) } } }
                    .autocorrectionDisabled()
                if !query.isEmpty {
                    Button { query = "" } label: {
                        Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary).frame(width: 44, height: 44)
                    }
                    .accessibilityLabel("Eingabe löschen")
                }
            }
            .padding(.leading, 16)
            .frame(minHeight: 48)
            .glass(in: Capsule())
            Button { dismiss() } label: {
                Image(systemName: "xmark").font(.system(size: 18, weight: .medium)).frame(width: 48, height: 48)
            }
            .glass(in: Circle())
            .accessibilityLabel("Abbrechen")
        }
        .foregroundStyle(Color.ink)
        .padding(.horizontal, 16)
        .padding(.top, 16)
        .padding(.bottom, 8)
    }

    /// An address starts on its own street, as in the planner: its centre can lie nearer a path behind it, such as a
    /// park; the search waits for that at most three seconds.
    private func choose(_ place: Place) async {
        var coord = place.coord
        if let street = place.street, let engine {
            let found = Task { await engine.point(on: street, near: place.coord) }
            let timeout = Task { try? await Task.sleep(for: .seconds(3)); found.cancel() }
            coord = await found.value ?? coord
            timeout.cancel()
        }
        choose(coord, place.label)
        dismiss()
    }

    private func chooseLocation() async {
        locating = true
        defer { locating = false }
        guard let coord = await Location.current() else { return locationFailed = true }
        choose(coord, nil)
        dismiss()
    }
}

/// The rider's position, once, after asking for permission the first time.
@MainActor
final class Location: NSObject, CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private var waiting: CheckedContinuation<[Double]?, Never>?

    static func current() async -> [Double]? {
        let location = Location()
        return await withCheckedContinuation { continuation in
            location.waiting = continuation
            location.manager.delegate = location
            location.manager.desiredAccuracy = kCLLocationAccuracyNearestTenMeters
            switch location.manager.authorizationStatus {
            case .notDetermined: location.manager.requestWhenInUseAuthorization()
            case .denied, .restricted: location.finish(nil)
            default: location.manager.requestLocation()
            }
        }
    }

    private func finish(_ coord: [Double]?) {
        waiting?.resume(returning: coord)
        waiting = nil
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status = manager.authorizationStatus
        Task { @MainActor in
            switch status {
            case .authorizedWhenInUse, .authorizedAlways: self.manager.requestLocation()
            case .denied, .restricted: finish(nil)
            default: break
            }
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        let coord = locations.last.map { [$0.coordinate.longitude, $0.coordinate.latitude] }
        Task { @MainActor in finish(coord) }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        Task { @MainActor in finish(nil) }
    }
}
