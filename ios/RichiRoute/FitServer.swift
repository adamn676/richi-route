import Foundation
import Network

/// Serves FIT files over HTTP on 127.0.0.1, `/1.fit` the first, for the Edge to fetch through Garmin Connect
/// (`makeWebRequest`).
final class FitServer: Sendable {
    let port: UInt16
    private let listener: NWListener

    /// `served` gets each request's first line, the bytes handed over and the seconds that took.
    init(serving fits: [Data], served: @escaping @Sendable (String, Int, Double) -> Void) async throws {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any)
        let listener = try NWListener(using: parameters)
        listener.newConnectionHandler = { Self.answer($0, from: fits, served: served) }
        port = try await withCheckedThrowingContinuation { continuation in
            listener.stateUpdateHandler = { state in
                switch state {
                case .ready: continuation.resume(returning: listener.port?.rawValue ?? 0)
                case .failed(let error), .waiting(let error): continuation.resume(throwing: error)
                case .cancelled: continuation.resume(throwing: CancellationError())
                default: return
                }
                listener.stateUpdateHandler = nil
            }
            listener.start(queue: .global())
        }
        self.listener = listener
    }

    deinit {
        listener.cancel()
    }

    private static func answer(_ connection: NWConnection, from fits: [Data],
                               served: @escaping @Sendable (String, Int, Double) -> Void) {
        connection.start(queue: .global())
        connection.receive(minimumIncompleteLength: 1, maximumLength: 16_384) { request, _, _, _ in
            let started = ContinuousClock.now
            let line = String(String(decoding: request ?? Data(), as: UTF8.self).prefix { !$0.isNewline })
            let path = line.split(separator: " ").dropFirst().first ?? ""
            let fit = path.wholeMatch(of: /\/(\d+)\.fit/).flatMap { Int($0.1) }.flatMap { fits.indices.contains($0 - 1) ? fits[$0 - 1] : nil }
            let head = fit.map { "HTTP/1.1 200 OK\r\nContent-Type: application/vnd.ant.fit\r\nContent-Length: \($0.count)\r\n" }
                ?? "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n"
            connection.send(content: Data((head + "Connection: close\r\n\r\n").utf8) + (fit ?? Data()), completion: .contentProcessed { _ in
                served(line, fit?.count ?? 0, started.duration(to: .now) / .seconds(1))
                connection.cancel()
            })
        }
    }
}
