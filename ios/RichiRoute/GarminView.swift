import ConnectIQ
import SwiftUI

/// A test of the way a route reaches the Edge: the engine in the app makes its FIT courses (parts over
/// 400 km) and serves them on 127.0.0.1; a short message tells RichiRoute's Edge app (garmin/) where, and
/// the Edge has Garmin Connect fetch each part, which stores it as a Garmin course.
struct GarminView: View {
    struct Test: Identifiable {
        let id: String
        let points: [[Double]]
    }

    struct Course {
        let parts: [(name: String, fit: Data)]
        let track: [[Double]]
        let server: FitServer
    }

    static let tests = [
        Test(id: "Graz – Leibnitz", points: [[15.4383, 47.0712], [15.5386, 46.7826]]),
        Test(id: "Virgen – Mistelbach", points: [ProofView.virgen, [16.577, 48.57]]),
    ]

    let engine: Engine?
    @State private var test = tests[0].id
    @State private var course: Course?
    @State private var running = false
    @State private var log: [String] = []

    /// Not stored: the link to this screen makes it at app start, and Connect IQ would ask for Bluetooth then.
    private var garmin: Garmin { .shared }

    var body: some View {
        List {
            Section("Edge") {
                Text(garmin.statusText)
                Button("Edge wählen (öffnet Garmin Connect)") { garmin.choose() }
            }
            Section("Senden") {
                Picker("Route", selection: $test) {
                    ForEach(Self.tests) { Text($0.id).tag($0.id) }
                }
                Button("An Edge senden") { Task { await run() } }
                    .disabled(engine == nil || garmin.device == nil || running)
            }
            Section("Protokoll") {
                ForEach(log.indices, id: \.self) { Text(log[$0]).font(.footnote) }
            }
        }
        .navigationTitle("Garmin-Test")
        .onChange(of: test) { course = nil }
        .onAppear { garmin.onReport = { note("Edge: \($0)") } }
    }

    private func note(_ line: String) {
        log.append("\(Date.now.formatted(date: .omitted, time: .standard))  \(line)")
    }

    private func run() async {
        running = true
        defer { running = false }
        log = []
        guard let course = await prepare() else { return }
        switch await garmin.appVersion() {
        case nil: note("Edge antwortet nicht")
        case 0: note("Edge-App nicht installiert (laut Edge)")
        case let version?: note("Edge-App Version \(version)")
        }
        // every n-th point, at most 200, as whole 1e-5 degrees: enough to draw the route on the Edge
        let step = max(course.track.count / 200, 1)
        let track = stride(from: 0, to: course.track.count, by: step).flatMap { [Int(course.track[$0][1] * 1e5), Int(course.track[$0][0] * 1e5)] }
        let parts = course.parts.enumerated().map { index, part in
            ["name": part.name, "size": part.fit.count, "url": "http://127.0.0.1:\(course.server.port)/\(index + 1).fit"] as [String: Any]
        }
        let started = ContinuousClock.now
        let result = await garmin.send(["name": test, "track": track, "parts": parts])
        note("Nachricht an den Edge: \(NSStringFromSendMessageResult(result) ?? "?") in \(seconds(since: started)) s")
    }

    /// The test route's FIT parts, served on 127.0.0.1; made once per route.
    private func prepare() async -> Course? {
        if let course { return course }
        guard let engine, let points = Self.tests.first(where: { $0.id == test })?.points else { return nil }
        do {
            let started = ContinuousClock.now
            let route = try await engine.route(points)
            let parts = try await engine.fit(name: test, coordinates: Engine.track(route))
            note("\(parts.count) FIT-Datei(en), \(parts.map { "\($0.fit.count) B" }.joined(separator: " + ")), in \(seconds(since: started)) s berechnet")
            let server = try await FitServer(serving: parts.map(\.fit)) { request, bytes, seconds in
                Task { @MainActor in
                    note("Garmin Connect holt \(request): \(bytes) B in \(String(format: "%.2f", seconds)) s übergeben")
                }
            }
            course = Course(parts: parts, track: Engine.track(route), server: server)
            return course
        } catch {
            note("Fehler: \((error as? Engine.Failure)?.message ?? error.localizedDescription)")
            return nil
        }
    }

    private func seconds(since start: ContinuousClock.Instant) -> String {
        String(format: "%.1f", start.duration(to: .now) / .seconds(1))
    }
}
