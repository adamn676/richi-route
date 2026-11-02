import SwiftUI

@main
struct RichiRouteApp: App {
    var body: some Scene {
        WindowGroup {
            Group {
                // the measuring screen for long routes and the Garmin test (RichiRouteUITests launches it)
                if CommandLine.arguments.contains("-proof") { ProofView() } else { PlannerView() }
            }
            // Garmin Connect returns the chosen Edge here, also when iOS ended the app meanwhile
            .onOpenURL { Garmin.shared.open($0) }
        }
    }
}
