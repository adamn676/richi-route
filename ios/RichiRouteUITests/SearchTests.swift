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
        // each town among the suggestions, seen from wherever the map is
        let towns = [("Graz", "Graz, Steiermark"), ("Feldkirch", "Feldkirch, Vorarlberg"),
                     ("Hermagor", "Hermagor, Kärnten"), ("Neusiedl am See", "Neusiedl am See, Burgenland")]
        for (typed, town) in towns {
            let started = Date()
            field.typeText(typed)
            let suggestion = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@ AND label CONTAINS %@", typed, town)).firstMatch
            let found = suggestion.waitForExistence(timeout: 30)
            let first = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", typed)).firstMatch
            print("SEARCH \(typed): \(found ? "found" : "not found") after \(String(format: "%.1f", Date().timeIntervalSince(started))) s, first „\(first.label)“")
            XCTAssertTrue(found, "\(town) not among the suggestions")
            field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: typed.count))
        }
        app.buttons["Abbrechen"].tap()
    }
}
