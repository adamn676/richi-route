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

        // two Zwischenstopps, each added from its search by a tap on the map; their grips show that they change places
        // when held and dragged
        let spots = [CGVector(dx: 0.3, dy: 0.25), CGVector(dx: 0.6, dy: 0.2), CGVector(dx: 0.45, dy: 0.3), CGVector(dx: 0.7, dy: 0.3)]
        for (index, spot) in spots.enumerated() {
            grabber.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 0.2, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.1)))
            // further down the list with each stop
            let add = app.buttons["Zwischenstopp hinzufügen"]
            for _ in 0..<4 where !add.isHittable { app.swipeUp() }
            add.tap()
            XCTAssertTrue(app.textFields["Zwischenstopp \(index + 1) suchen"].waitForExistence(timeout: 5))
            app.buttons["Auf der Karte wählen"].tap()
            XCTAssertTrue(app.staticTexts["Neuen Zwischenstopp \(index + 1) antippen"].waitForExistence(timeout: 5))
            app.coordinate(withNormalizedOffset: spot).tap()
            XCTAssertTrue(app.staticTexts["Neuen Zwischenstopp \(index + 1) antippen"].waitForNonExistence(timeout: 5))
        }
        grabber.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 0.2, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.1)))
        let group = app.buttons.matching(NSPredicate(format: "label BEGINSWITH '4 Zwischenstopps'")).firstMatch
        XCTAssertTrue(group.waitForExistence(timeout: 10), "four Zwischenstopps not one row")
        shot(app, "10-grips")
        // four and more are one row, open after adding; a tap folds it
        group.tap()
        XCTAssertTrue(app.buttons["Zwischenstopp 1 entfernen"].waitForNonExistence(timeout: 5))
        shot(app, "11-grouped")
        // the four undone on the map, the panel folded
        grabber.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 0.2, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.98)))
        for _ in 1...4 { app.buttons["Rückgängig"].tap() }
        XCTAssertTrue(group.waitForNonExistence(timeout: 5))
        XCTAssertTrue(figures.waitForExistence(timeout: 30))
    }

    /// Moves a Formpunkt, reorders two Zwischenstopps around it, and renames, duplicates and deletes the route in
    /// "Meine Routen".
    @MainActor
    func testEditsStopsAndSavedRoutes() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["-fresh"]
        app.launch()
        let grabber = app.buttons["Sheet Grabber"]
        let raise = { grabber.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 0.2, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.1))) }
        let lower = { grabber.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 0.2, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.98))) }
        let map = { (x: Double, y: Double) in app.coordinate(withNormalizedOffset: CGVector(dx: x, dy: y)) }
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Tipp:'")).firstMatch.waitForExistence(timeout: 60))
        sleep(2)
        map(0.25, 0.3).tap()
        sleep(1)
        map(0.75, 0.42).tap()
        let figures = app.staticTexts.matching(NSPredicate(format: "label ENDSWITH ' km'")).firstMatch
        XCTAssertTrue(figures.waitForExistence(timeout: 60), "no route")
        // the distance once the route has changed from `before`
        let distance = { (before: String) -> String in
            let changed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == true AND label != %@", before), object: figures)
            XCTAssertEqual(XCTWaiter().wait(for: [changed], timeout: 60), .completed, "the route still \(before)")
            return figures.label
        }
        let direct = figures.label

        // a Formpunkt dragged out of the route, then held and dragged on; one undo puts it back
        map(0.567, 0.356).press(forDuration: 0.6, thenDragTo: map(0.52, 0.46))
        let shaped = distance(direct)
        sleep(1)
        map(0.52, 0.46).press(forDuration: 0.6, thenDragTo: map(0.42, 0.55))
        let moved = distance(shaped)
        shot(app, "e1-formpunkt-moved")
        app.buttons["Rückgängig"].tap()
        XCTAssertEqual(distance(moved), shaped, "undo did not put the Formpunkt back")

        // two Zwischenstopps, the farther first, held and dragged into the other order; the Formpunkt keeps its place
        for (index, spot) in [(0.62, 0.2), (0.3, 0.22)].enumerated() {
            let before = figures.label
            raise()
            let add = app.buttons["Zwischenstopp hinzufügen"]
            for _ in 0..<4 where !add.isHittable { app.swipeUp() }
            add.tap()
            app.buttons["Auf der Karte wählen"].tap()
            XCTAssertTrue(app.staticTexts["Neuen Zwischenstopp \(index + 1) antippen"].waitForExistence(timeout: 5))
            map(spot.0, spot.1).tap()
            _ = distance(before)
        }
        raise()
        let first = app.buttons["Zwischenstopp 1 entfernen"], second = app.buttons["Zwischenstopp 2 entfernen"]
        XCTAssertTrue(second.waitForExistence(timeout: 5))
        // a stop's name: the widest text in the row of its badge or × button
        let name = { (inRow: XCUIElement) -> String in
            app.staticTexts.allElementsBoundByIndex.filter { abs($0.frame.midY - inRow.frame.midY) < 12 }
                .max { $0.frame.width < $1.frame.width }?.label ?? ""
        }
        let start = app.staticTexts["S"].firstMatch
        let names = (name(first), name(second))
        XCTAssertNotEqual(names.0, names.1)
        let ordered = figures.label
        shot(app, "e2-stops")
        let title = app.staticTexts.matching(NSPredicate(format: "label CONTAINS ' → '")).firstMatch
        let before = title.label
        // the second dragged up to the top, and held there until the rows have made room: the new Start, as in Apple Maps
        second.coordinate(withNormalizedOffset: CGVector(dx: -4, dy: 0.5)).press(
            forDuration: 1, thenDragTo: start.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: -0.4)), withVelocity: .slow,
            thenHoldForDuration: 0.5)
        // the route's name follows its new Start
        let newStart = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label BEGINSWITH %@", names.1.components(separatedBy: ",")[0]), object: title)
        XCTAssertEqual(XCTWaiter().wait(for: [newStart], timeout: 10), .completed, "not the new Start: \(title.label)")
        XCTAssertTrue(figures.waitForExistence(timeout: 60))
        XCTAssertEqual(name(start), names.1)
        XCTAssertEqual(name(app.buttons["Zwischenstopp 2 entfernen"]), names.0)
        shot(app, "e3-reordered")
        app.buttons["Weitere Aktionen"].tap()
        let unshape = app.buttons["Formpunkte entfernen"]
        XCTAssertTrue(unshape.waitForExistence(timeout: 5), "the Formpunkt lost in reordering")
        // the menu closed by a tap beside it, which the panel below does not take
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.25)).tap()
        XCTAssertTrue(unshape.waitForNonExistence(timeout: 5))
        lower()
        app.buttons["Rückgängig"].tap()
        XCTAssertTrue(app.staticTexts[before].waitForExistence(timeout: 10), "undo did not restore the Start")
        XCTAssertTrue(figures.waitForExistence(timeout: 60))
        XCTAssertEqual(figures.label, ordered)
        raise()
        XCTAssertEqual(name(app.buttons["Zwischenstopp 1 entfernen"]), names.0, "undo did not restore the order")

        // saved, then in "Meine Routen" renamed, which the open route takes on, duplicated, and the copy and then the
        // route itself deleted, which leaves the route open but no longer saved
        app.buttons["Weitere Aktionen"].tap()
        app.buttons["In „Meine Routen“ speichern …"].tap()
        let field = app.textFields["Routenname"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        for _ in 0..<3 where !(field.value as? String ?? "").isEmpty {
            field.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: 0.5)).tap()
            field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: (field.value as? String ?? "").count + 5))
        }
        // names of this run's own, clear of routes earlier runs left
        let saved = "Runde \(Int.random(in: 1000...9999))", renamed = "Umbenannt \(Int.random(in: 1000...9999))"
        let copy = renamed + " (Kopie)"
        field.typeText(saved + "\n")
        XCTAssertTrue(app.staticTexts[saved].waitForExistence(timeout: 5))
        raise()
        app.buttons["Meine Routen"].tap()
        let entry = { (label: String) in app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", label + ",")).firstMatch }
        XCTAssertTrue(entry(saved).waitForExistence(timeout: 5))
        entry(saved).press(forDuration: 1)
        app.buttons["Umbenennen"].tap()
        let rename = app.alerts["Route umbenennen"].textFields.firstMatch
        XCTAssertTrue(rename.waitForExistence(timeout: 5))
        rename.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: saved.count + 5) + renamed)
        app.alerts.buttons["Umbenennen"].tap()
        XCTAssertTrue(entry(renamed).waitForExistence(timeout: 5), "not renamed")
        XCTAssertFalse(entry(saved).exists)
        entry(renamed).press(forDuration: 1)
        app.buttons["Duplizieren"].tap()
        XCTAssertTrue(entry(copy).waitForExistence(timeout: 5), "no copy")
        shot(app, "e4-renamed-copied")
        entry(copy).swipeLeft()
        app.buttons["Löschen"].tap()
        app.alerts.buttons["Endgültig löschen"].tap()
        XCTAssertTrue(entry(copy).waitForNonExistence(timeout: 5), "copy not deleted")
        XCTAssertTrue(entry(renamed).exists, "the original went with the copy")
        app.buttons["Route"].tap()
        XCTAssertTrue(app.staticTexts[renamed].waitForExistence(timeout: 5), "the open route kept its old name")
        app.buttons["Meine Routen"].tap()
        entry(renamed).swipeLeft()
        app.buttons["Löschen"].tap()
        app.alerts.buttons["Endgültig löschen"].tap()
        XCTAssertTrue(entry(renamed).waitForNonExistence(timeout: 5))
        app.buttons["Route"].tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS ' → '")).firstMatch.waitForExistence(timeout: 5),
                      "the deleted route's name still on the open route")
        XCTAssertEqual(figures.label, ordered, "the open route changed")
        shot(app, "e5-deleted")
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
