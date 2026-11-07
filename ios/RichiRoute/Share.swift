import UIKit
import UniformTypeIdentifiers

extension UTType {
    /// Declared in project.yml, as the app opens them.
    static let gpx = UTType(importedAs: "com.topografix.gpx", conformingTo: .xml)
    static let richiRoute = UTType(exportedAs: "com.adamn.richiroute", conformingTo: .json)
}

/// The system's share sheet, over whatever the app shows: it sends files to other apps, AirDrop, Mail or Files.
@MainActor
enum Share {
    /// Shares the files of one folder and removes the folder after.
    static func present(_ files: [URL]) {
        let remove = { if let folder = files.first?.deletingLastPathComponent() { try? FileManager.default.removeItem(at: folder) } }
        guard let scene = UIApplication.shared.connectedScenes.first(where: { $0.activationState == .foregroundActive }) as? UIWindowScene,
              var top = scene.keyWindow?.rootViewController else { return remove() }
        while let presented = top.presentedViewController { top = presented }
        let sheet = UIActivityViewController(activityItems: files, applicationActivities: nil)
        sheet.completionWithItemsHandler = { _, _, _, _ in remove() }
        top.present(sheet, animated: true)
    }
}
