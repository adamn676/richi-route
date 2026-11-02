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
        // the profile, below the stops in the raised panel
        let grabber = app.buttons["Sheet Grabber"]
        grabber.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 0.2, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.1)))
        XCTAssertTrue(app.otherElements.matching(NSPredicate(format: "label BEGINSWITH 'Höhenprofil'")).firstMatch.waitForExistence(timeout: 20))
        shot(app, "2b-profile")
        grabber.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 0.2, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.98)))

        app.buttons["Rückgängig"].tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Tipp:'")).firstMatch.waitForExistence(timeout: 10))
        app.buttons["Wiederholen"].tap()
        XCTAssertTrue(figures.waitForExistence(timeout: 30))
        shot(app, "3-redone")

        // the search closes with its X, the stop unchanged
        app.staticTexts["S"].firstMatch.tap()
        let search = app.textFields["Start suchen"]
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        app.buttons["Abbrechen"].tap()
        XCTAssertTrue(search.waitForNonExistence(timeout: 5))

        // the Start by an address: tap its row, search, choose
        app.staticTexts["S"].firstMatch.tap()
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        search.typeText("Herrengasse 16")
        let suggestion = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Herrengasse 16'")).firstMatch
        XCTAssertTrue(suggestion.waitForExistence(timeout: 15), "no suggestion")
        shot(app, "4-search")
        suggestion.tap()
        XCTAssertTrue(app.staticTexts["Herrengasse 16, 8010 Graz, Steiermark"].waitForExistence(timeout: 30), "Start not named by the place")
        XCTAssertTrue(figures.waitForExistence(timeout: 60))
        shot(app, "5-address")

        // the Ziel on the map: tap its row, "Auf der Karte wählen", then the map
        app.staticTexts["Z"].firstMatch.tap()
        app.buttons["Auf der Karte wählen"].tap()
        let hint = app.staticTexts["Neues Ziel antippen"]
        XCTAssertTrue(hint.waitForExistence(timeout: 5))
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.4, dy: 0.2)).tap()
        XCTAssertTrue(hint.waitForNonExistence(timeout: 5))
        XCTAssertTrue(figures.waitForExistence(timeout: 60))
        shot(app, "6-picked")
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
