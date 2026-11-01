import ConnectIQ
import Foundation

/// The Edge through Garmin's Connect IQ Mobile SDK: chosen once in Garmin Connect, then reached over
/// Bluetooth directly, without Garmin Connect or the internet.
@MainActor @Observable
final class Garmin: NSObject, IQDeviceEventDelegate, IQAppMessageDelegate {
    /// Created on first use, so the app asks for Bluetooth only on the Garmin screen.
    static let shared = Garmin()
    /// The scheme Garmin Connect returns the chosen devices to (`CFBundleURLTypes` in project.yml).
    static let urlScheme = "richiroute-ciq"
    /// RichiRoute's Edge app (garmin/manifest.xml).
    static let appID = UUID(uuidString: "fdbb9fd4-bea0-4b44-8a03-f79fe08c8902")!
    private static let deviceKey = "garminDevice"

    private(set) var device: IQDevice?
    private(set) var status = IQDeviceStatus.invalidDevice
    /// Whether the Edge's Bluetooth services are found, after which it takes messages.
    private(set) var ready = false
    /// Gets each line the Edge app sends back, such as a part's fetch time.
    var onReport: ((String) -> Void)?

    var app: IQApp? { device.map { IQApp(uuid: Self.appID, store: Self.appID, device: $0) } }

    var statusText: String {
        guard let device else { return "Kein Edge gewählt" }
        let state = switch status {
        case .connected: ready ? "verbunden" : "verbindet …"
        case .notConnected: "nicht verbunden"
        case .notFound: "nicht gefunden"
        case .bluetoothNotReady: "Bluetooth aus"
        default: "unbekannt"
        }
        return "\(device.friendlyName ?? device.modelName ?? "Edge"): \(state)"
    }

    private override init() {
        super.init()
        ConnectIQ.sharedInstance().initialize(withUrlScheme: Self.urlScheme, uiOverrideDelegate: nil)
        if let data = UserDefaults.standard.data(forKey: Self.deviceKey),
           let device = try? NSKeyedUnarchiver.unarchivedObject(ofClass: IQDevice.self, from: data) {
            use(device)
        }
    }

    /// Opens Garmin Connect, which returns the chosen devices through `open`.
    func choose() {
        ConnectIQ.sharedInstance().showDeviceSelection()
    }

    func open(_ url: URL) {
        guard url.scheme == Self.urlScheme,
              let device = ConnectIQ.sharedInstance().parseDeviceSelectionResponse(from: url)?.first as? IQDevice else { return }
        UserDefaults.standard.set(try? NSKeyedArchiver.archivedData(withRootObject: device, requiringSecureCoding: true),
                                  forKey: Self.deviceKey)
        use(device)
    }

    /// The Edge app's version, 0 when it is not installed, nil when the Edge does not answer.
    func appVersion() async -> Int? {
        guard let app else { return nil }
        return await withCheckedContinuation { continuation in
            ConnectIQ.sharedInstance().getAppStatus(app) { @Sendable status in
                continuation.resume(returning: status.map { $0.isInstalled ? Int($0.version) : 0 })
            }
        }
    }

    func send(_ message: [String: Any]) async -> IQSendMessageResult {
        guard let app else { return .failure_DeviceNotAvailable }
        return await withCheckedContinuation { continuation in
            ConnectIQ.sharedInstance().sendMessage(message, to: app, progress: { @Sendable _, _ in },
                                                   completion: { @Sendable result in continuation.resume(returning: result) })
        }
    }

    private func use(_ device: IQDevice) {
        let connectIQ = ConnectIQ.sharedInstance()!
        connectIQ.unregister(forAllDeviceEvents: self)
        connectIQ.unregister(forAllAppMessages: self)
        self.device = device
        ready = false
        connectIQ.register(forDeviceEvents: device, delegate: self)
        status = connectIQ.getDeviceStatus(device)
        connectIQ.register(forAppMessages: app, delegate: self)
    }

    nonisolated func deviceStatusChanged(_ device: IQDevice!, status: IQDeviceStatus) {
        Task { @MainActor in
            self.status = status
            if status != .connected { ready = false }
        }
    }

    nonisolated func deviceCharacteristicsDiscovered(_ device: IQDevice!) {
        Task { @MainActor in ready = true }
    }

    nonisolated func receivedMessage(_ message: Any!, from app: IQApp!) {
        let lines = message as? [String] ?? [String(describing: message ?? "")]
        Task { @MainActor in lines.forEach { onReport?($0) } }
    }
}
