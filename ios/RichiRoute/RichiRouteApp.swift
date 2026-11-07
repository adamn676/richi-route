import SwiftUI

@main
struct RichiRouteApp: App {
    /// A GPX track or RichiRoute file handed over by another app, until the planner takes it.
    @State private var opened: URL?

    init() {
        // the UI tests start from the same map each time
        if CommandLine.arguments.contains("-fresh") { [Basemap.key, Basemap.cycleRoutesKey].forEach(UserDefaults.standard.removeObject) }
        // and hand over a file as another app would
        if let path = ProcessInfo.processInfo.environment["RICHIROUTE_OPEN"] { _opened = State(initialValue: URL(filePath: path)) }
    }

    var body: some Scene {
        WindowGroup {
            Group {
                // the measuring screen for long routes and the Garmin test (RichiRouteUITests launches it)
                if CommandLine.arguments.contains("-proof") { ProofView() } else { PlannerView(opened: $opened) }
            }
            // Garmin Connect returns the chosen Edge here, also when iOS ended the app meanwhile
            .onOpenURL { url in if url.isFileURL { opened = url } else { Garmin.shared.open(url) } }
        }
    }
}
