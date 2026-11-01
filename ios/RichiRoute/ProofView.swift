import SwiftUI

/// The first test on the phone: long routes and a loop through the engine in the app, each with its
/// time and the app's memory, the last one on the map.
struct ProofView: View {
    struct Case: Identifiable {
        let id: String
        let points: [[Double]]
        var extra: [URLQueryItem] = []
    }

    struct Outcome {
        let seconds: Double
        let memory: Memory
        let result: Result<Double, Engine.Failure>
    }

    static let virgen = [12.4566574, 47.0029984], graz = [15.4395, 47.0707], mistelbach = [16.577, 48.57]
    let cases = [
        Case(id: "Graz – Virgen", points: [graz, virgen]),
        Case(id: "Graz – Mistelbach", points: [graz, mistelbach]),
        Case(id: "Virgen – Mistelbach", points: [virgen, mistelbach]),
        Case(id: "Wien – München (über der Grenze)", points: [[16.3725, 48.2083], [11.5755, 48.1374]]),
        Case(id: "Runde ab Virgen, 60 km", points: [virgen], extra: [
            URLQueryItem(name: "engineMode", value: "4"), URLQueryItem(name: "roundTripDistance", value: "9700"),
            URLQueryItem(name: "direction", value: "189"), URLQueryItem(name: "roundTripPoints", value: "5"),
        ]),
    ]

    @State private var engine: Engine?
    @State private var starting = true
    @State private var outcomes: [String: Outcome] = [:]
    @State private var running: String?
    @State private var route: Data?

    var body: some View {
        VStack(spacing: 0) {
            RouteMap(route: route)
            List {
                if starting {
                    Label("Routing-Engine startet …", systemImage: "hourglass")
                } else if engine == nil {
                    Text("Die Routing-Engine startet nicht: Routing-Daten fehlen.").foregroundStyle(.red)
                }
                ForEach(cases) { item in
                    Button { Task { await run(item) } } label: { row(item) }
                        .disabled(engine == nil || running != nil)
                }
            }
        }
        .task {
            engine = await Engine.start()
            starting = false
        }
    }

    private func row(_ item: Case) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(item.id)
                Spacer()
                if running == item.id { ProgressView() }
            }
            if let outcome = outcomes[item.id] {
                Group {
                    switch outcome.result {
                    case .success(let km): Text("\(km, specifier: "%.1f") km in \(outcome.seconds, specifier: "%.1f") s")
                    case .failure(let failure): Text("\(failure.message) nach \(outcome.seconds, specifier: "%.1f") s").foregroundStyle(.red)
                    }
                    Text("Speicher \(mb(outcome.memory.footprint)), Spitze \(mb(outcome.memory.peak)), frei \(mb(outcome.memory.available))")
                }
                .font(.footnote).foregroundStyle(.secondary)
            }
        }
    }

    private func mb(_ bytes: UInt64) -> String { "\(bytes >> 20) MB" }

    private func run(_ item: Case) async {
        guard let engine else { return }
        running = item.id
        let started = ContinuousClock.now
        let result: Result<Double, Engine.Failure>
        do {
            let data = try await engine.route(item.points, extra: item.extra)
            route = data
            result = .success(Self.kilometres(data))
        } catch let failure as Engine.Failure {
            result = .failure(failure)
        } catch {
            result = .failure(Engine.Failure(message: error.localizedDescription))
        }
        outcomes[item.id] = Outcome(seconds: started.duration(to: .now) / .seconds(1), memory: .now(), result: result)
        running = nil
    }

    /// The route's length from the answer's `track-length` (metres, as text).
    private static func kilometres(_ geojson: Data) -> Double {
        let json = try? JSONSerialization.jsonObject(with: geojson) as? [String: Any]
        let properties = (json?["features"] as? [[String: Any]])?.first?["properties"] as? [String: Any]
        return (Double(properties?["track-length"] as? String ?? "") ?? 0) / 1000
    }
}
