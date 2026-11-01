import SwiftUI

@main
struct RichiRouteApp: App {
    var body: some Scene {
        WindowGroup {
            // Garmin Connect returns the chosen Edge here, also when iOS ended the app meanwhile
            ProofView().onOpenURL { Garmin.shared.open($0) }
        }
    }
}
