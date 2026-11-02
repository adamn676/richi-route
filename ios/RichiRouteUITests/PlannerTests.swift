import XCTest

/// Plans a route by tapping the map, as a rider does: Start, Ziel, then a Zwischenstopp on the route, and
/// undoes it. `RICHIROUTE_SHOTS` names a folder for screenshots of each step.
final class PlannerTests: XCTestCase {
    @MainActor
    func testTapsPlanARoute() {
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Tipp:'")).firstMatch.waitForExistence(timeout: 60))
        shot(app, "1-empty")

        // a point on a road gets its street and town ("Körösistraße 2, 8010 Graz")
        let named = app.staticTexts.matching(NSPredicate(format: "label MATCHES '.+, [0-9]{4} .+'")).firstMatch
        // the map takes its taps once it has drawn
        sleep(2)
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.25, dy: 0.3)).tap()
        XCTAssertTrue(named.waitForExistence(timeout: 30), "no named Start")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.75, dy: 0.42)).tap()
        let figures = app.staticTexts.matching(NSPredicate(format: "label CONTAINS ' km'")).firstMatch
        XCTAssertTrue(figures.waitForExistence(timeout: 60), "no route between the two taps")
        shot(app, "2-route")

        app.buttons["Rückgängig"].tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Tipp:'")).firstMatch.waitForExistence(timeout: 10))
        app.buttons["Wiederholen"].tap()
        XCTAssertTrue(figures.waitForExistence(timeout: 30))
        shot(app, "3-redone")

        // replacing the Start: tap its row, then the map
        let start = named.label
        app.staticTexts["S"].firstMatch.tap()
        let hint = app.staticTexts["Neuen Start antippen"]
        XCTAssertTrue(hint.waitForExistence(timeout: 5))
        shot(app, "4-picking")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.4, dy: 0.2)).tap()
        XCTAssertTrue(hint.waitForNonExistence(timeout: 5))
        XCTAssertTrue(figures.waitForExistence(timeout: 60))
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label == %@", start)).firstMatch.waitForNonExistence(timeout: 10), "Start not replaced")
        shot(app, "5-replaced")
    }

    @MainActor
    private func shot(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        guard let folder = ProcessInfo.processInfo.environment["RICHIROUTE_SHOTS"] else { return }
        try? app.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: folder).appending(path: "\(name).png"))
    }
}
