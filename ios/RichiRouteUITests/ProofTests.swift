import XCTest

/// Taps each test case of the first screen and logs its result, so the phone measures without anyone
/// tapping: `xcodebuild test` with the device as destination.
final class ProofTests: XCTestCase {
    @MainActor
    func testRoutesAndLoop() {
        let app = XCUIApplication()
        app.launchArguments = ["-proof"]
        app.launch()
        let budget = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Suche bis'")).firstMatch
        XCTAssertTrue(budget.waitForExistence(timeout: 30))
        print("RESULT \(budget.label)")
        let names = ["Virgen – Mistelbach", "Wien – München", "Wien – Bregenz", "Graz – Mailand", "Neusiedl – Feldkirch",
                     "Bratislava – Zürich", "Wien – Salzburg – Bregenz", "Runde ab Virgen"]
        for name in names {
            let row = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", name)).firstMatch
            // the list makes its lower rows only when they scroll into view
            while !row.exists { app.collectionViews.firstMatch.swipeUp() }
            row.tap()
            let done = NSPredicate(format: "label CONTAINS 'Speicher'")
            XCTAssertEqual(XCTWaiter.wait(for: [expectation(for: done, evaluatedWith: row)], timeout: 180), .completed, name)
            print("RESULT \(row.label)")
        }
    }
}
