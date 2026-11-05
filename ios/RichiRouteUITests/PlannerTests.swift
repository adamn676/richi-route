import XCTest

/// Plans a route by tapping the map, as a rider does: Start, Ziel, then a Zwischenstopp on the route, and
/// undoes it. `RICHIROUTE_SHOTS` names a folder for screenshots of each step.
final class PlannerTests: XCTestCase {
    @MainActor
    func testTapsPlanARoute() {
        let app = XCUIApplication()
        // without the route the app closed with, on the same map each time
        app.launchArguments = ["-fresh"]
        app.launch()
        let tip = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Tipp:'")).firstMatch
        let grabber = app.buttons["Sheet Grabber"]
        XCTAssertTrue(tip.waitForExistence(timeout: 60))
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
        // the route held and dragged aside: a Formpunkt there, which "Formpunkte entfernen" takes away again
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.567, dy: 0.356))
            .press(forDuration: 0.6, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.52, dy: 0.46)))
        app.buttons["Weitere Aktionen"].tap()
        let unshape = app.buttons["Formpunkte entfernen"]
        XCTAssertTrue(unshape.waitForExistence(timeout: 5), "no Formpunkt after dragging the route")
        shot(app, "2a-formpunkt")
        unshape.tap()
        // both one undo step each: the Formpunkt back, then gone again
        app.buttons["Rückgängig"].tap()
        app.buttons["Rückgängig"].tap()
        XCTAssertTrue(figures.waitForExistence(timeout: 60))
        // the profile, under the figures in the half-raised panel, the route on the map above it
        grabber.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 0.2, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.45)))
        let chart = app.otherElements.matching(NSPredicate(format: "label BEGINSWITH 'Höhenprofil'")).firstMatch
        XCTAssertTrue(chart.waitForExistence(timeout: 20))
        XCTAssertTrue(app.staticTexts["Zum Zoomen halten und ziehen"].exists)
        shot(app, "2b-profile")
        // a finger drawn along the profile points along the route, and lets go of it when lifted
        chart.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.5))
            .press(forDuration: 0.05, thenDragTo: chart.coordinate(withNormalizedOffset: CGVector(dx: 0.6, dy: 0.5)), withVelocity: .slow, thenHoldForDuration: 0)
        XCTAssertTrue(app.staticTexts["Höhenprofil"].waitForExistence(timeout: 5))
        // held, then drawn, it marks a stretch and zooms into it
        chart.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.5))
            .press(forDuration: 0.8, thenDragTo: chart.coordinate(withNormalizedOffset: CGVector(dx: 0.7, dy: 0.5)))
        XCTAssertTrue(app.staticTexts["Ausschnitt"].waitForExistence(timeout: 10), "no zoomed stretch")
        shot(app, "2c-stretch")
        app.buttons["Ganzes Profil zeigen"].tap()
        XCTAssertTrue(app.staticTexts["Ausschnitt"].waitForNonExistence(timeout: 10))

        // a surface opens its sections, the first on the map; the arrows step through them, a second tap closes them
        grabber.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 0.2, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.1)))
        let paved = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Befestigt'")).firstMatch
        XCTAssertTrue(paved.waitForExistence(timeout: 20), "no surfaces")
        paved.tap()
        let count = app.staticTexts.matching(NSPredicate(format: "label MATCHES 'Befestigt · (1 von [0-9]+|1 Abschnitt)'")).firstMatch
        XCTAssertTrue(count.waitForExistence(timeout: 5), "no sections")
        shot(app, "2d-sections")
        if app.buttons["Nächster Abschnitt"].exists {
            app.buttons["Nächster Abschnitt"].tap()
            XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Befestigt · 2 von'")).firstMatch.waitForExistence(timeout: 5))
        }
        paved.tap()
        XCTAssertTrue(count.waitForNonExistence(timeout: 5))

        // undo and redo on the map
        app.buttons["Rückgängig"].tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Tipp:'")).firstMatch.waitForExistence(timeout: 10))
        app.buttons["Wiederholen"].tap()
        XCTAssertTrue(figures.waitForExistence(timeout: 30))
        shot(app, "3-redone")

        // the search closes with its X, the stop unchanged
        grabber.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 0.2, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.1)))
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

        // the route stays when the app is closed and opened again
        let routeName = app.staticTexts.matching(NSPredicate(format: "label CONTAINS ' → '")).firstMatch
        XCTAssertTrue(routeName.waitForExistence(timeout: 15))
        let title = routeName.label
        sleep(1)
        app.terminate()
        app.launchArguments = []
        app.launch()
        XCTAssertTrue(app.staticTexts[title].waitForExistence(timeout: 60), "\(title) not restored")
        XCTAssertTrue(figures.waitForExistence(timeout: 60))
        shot(app, "7-restored")

        // saved under a name, replaced by a new route, opened again from "Meine Routen"
        app.buttons["Weitere Aktionen"].tap()
        app.buttons["In „Meine Routen“ speichern …"].tap()
        let field = app.textFields["Routenname"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        // the suggested name, "A → B", replaced; a long one shows only in part, so a tap at its end may land inside it
        for _ in 0..<3 where !(field.value as? String ?? "").isEmpty {
            field.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: 0.5)).tap()
            field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: (field.value as? String ?? "").count + 5))
        }
        field.typeText("Testrunde\n")
        XCTAssertTrue(app.staticTexts["„Testrunde“ gespeichert."].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Testrunde"].waitForExistence(timeout: 5), "the saved name as the title")
        app.buttons["Weitere Aktionen"].tap()
        app.buttons["Neue Route"].tap()
        XCTAssertTrue(tip.waitForExistence(timeout: 10))
        // a new route starts a history of its own: nothing to undo
        let undo = app.buttons["Rückgängig"]
        XCTAssertFalse(undo.exists && undo.isHittable, "undo after a new route")
        grabber.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 0.2, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.1)))
        app.buttons["Meine Routen"].tap()
        let entry = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Testrunde'")).firstMatch
        XCTAssertTrue(entry.waitForExistence(timeout: 5))
        shot(app, "8-my-routes")
        entry.tap()
        XCTAssertTrue(app.staticTexts["„Testrunde“ geöffnet."].waitForExistence(timeout: 5))
        XCTAssertTrue(figures.waitForExistence(timeout: 30))
        shot(app, "9-opened")

        // two Zwischenstopps: their grips show that they change places when held and dragged
        let add = app.buttons["Zwischenstopp hinzufügen"]
        add.tap()
        add.tap()
        XCTAssertTrue(app.staticTexts["Zwischenstopp 2: Karte antippen"].waitForExistence(timeout: 5))
        shot(app, "10-grips")
        app.buttons["Zwischenstopp 2 entfernen"].tap()
        app.buttons["Zwischenstopp 1 entfernen"].tap()
        XCTAssertTrue(figures.waitForExistence(timeout: 30))
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
