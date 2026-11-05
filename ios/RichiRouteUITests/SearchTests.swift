import XCTest

/// Searches towns of several offline areas from the Start's search and logs what comes first and how soon, without
/// changing the route: made for the rider's own phone, with all its areas (`SEARCH` lines in the test log).
final class SearchTests: XCTestCase {
    @MainActor
    func testFindsTownsInEveryArea() {
        let app = XCUIApplication()
        app.launch()
        let grabber = app.buttons["Sheet Grabber"]
        XCTAssertTrue(grabber.waitForExistence(timeout: 20))
        grabber.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 0.2, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.1)))
        app.staticTexts["S"].firstMatch.tap()
        let field = app.textFields["Start suchen"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        for town in ["Graz", "Feldkirch", "Hermagor", "Neusiedl am See"] {
            let started = Date()
            field.typeText(town)
            let first = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", town)).firstMatch
            let found = first.waitForExistence(timeout: 30)
            print("SEARCH \(town): \(found ? "„\(first.label)“" : "nothing") after \(String(format: "%.1f", Date().timeIntervalSince(started))) s")
            XCTAssertTrue(found, "\(town) not found")
            field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: town.count))
        }
        app.buttons["Abbrechen"].tap()
    }
}
