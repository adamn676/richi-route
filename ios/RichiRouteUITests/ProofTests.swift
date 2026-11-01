import XCTest

/// Taps each test case of the first screen and logs its result, so the phone measures without anyone
/// tapping: `xcodebuild test` with the device as destination.
final class ProofTests: XCTestCase {
    @MainActor
    func testRoutesAndLoop() {
        let app = XCUIApplication()
        app.launch()
        for name in ["Graz – Virgen", "Graz – Mistelbach", "Virgen – Mistelbach", "Wien – München", "Runde ab Virgen"] {
            let row = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", name)).firstMatch
            row.tap()
            let done = NSPredicate(format: "label CONTAINS 'Speicher'")
            XCTAssertEqual(XCTWaiter.wait(for: [expectation(for: done, evaluatedWith: row)], timeout: 180), .completed, name)
            print("RESULT \(row.label)")
        }
    }
}
