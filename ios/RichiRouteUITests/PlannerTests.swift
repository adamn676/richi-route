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

        // the map takes its taps once it has drawn; the folded panel then offers a loop from the Start
        sleep(2)
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.25, dy: 0.3)).tap()
        XCTAssertTrue(app.buttons["Runde vorschlagen"].waitForExistence(timeout: 30), "no Start")
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
        history(app, "Rückgängig")
        history(app, "Rückgängig")
        XCTAssertTrue(figures.waitForExistence(timeout: 60))
        // the profile, under the figures in the half-raised panel, the route on the map above it
        panel(app, to: 0.45)
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
        // the whole route again, the stretch still marked
        app.buttons["Weitere Aktionen"].tap()
        app.buttons["Ganze Route zeigen"].tap()
        sleep(1)
        shot(app, "2c-whole")
        app.buttons["Ausschnitt schließen"].tap()
        XCTAssertTrue(app.staticTexts["Ausschnitt"].waitForNonExistence(timeout: 10))

        // a surface opens its sections, the first on the map; the arrows step through them, a second tap closes them
        panel(app, to: 0.1)
        let paved = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Befestigt'")).firstMatch
        XCTAssertTrue(paved.waitForExistence(timeout: 20), "no surfaces")
        // a point on a road gets its street and town ("Körösistraße 2, 8010 Graz")
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label MATCHES '.+, [0-9]{4} .+'")).firstMatch.waitForExistence(timeout: 30), "no named Start")
        paved.tap()
        let count = app.staticTexts.matching(NSPredicate(format: "label MATCHES 'Befestigt · (1 von [0-9]+|1 Abschnitt)'")).firstMatch
        XCTAssertTrue(count.waitForExistence(timeout: 5), "no sections")
        shot(app, "2d-sections")
        if app.buttons["Nächster Abschnitt"].exists {
            app.buttons["Nächster Abschnitt"].tap()
            XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Befestigt · 2 von'")).firstMatch.waitForExistence(timeout: 5))
        }
        // closed by its ×, the whole route again
        app.buttons["Abschnitte schließen"].tap()
        XCTAssertTrue(count.waitForNonExistence(timeout: 5))

        // undo and redo on the map
        history(app, "Rückgängig")
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Tipp:'")).firstMatch.waitForExistence(timeout: 10))
        history(app, "Wiederholen")
        XCTAssertTrue(figures.waitForExistence(timeout: 30))
        shot(app, "3-redone")

        // the search closes with its X, the stop unchanged
        panel(app, to: 0.1)
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
        panel(app, to: 0.1)
        app.buttons["Meine Routen"].tap()
        let entry = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Testrunde'")).firstMatch
        XCTAssertTrue(entry.waitForExistence(timeout: 5))
        shot(app, "8-my-routes")
        entry.tap()
        // the route itself on the map and in the half-lowered panel, no notice
        XCTAssertTrue(app.staticTexts["Testrunde"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["„Testrunde“ geöffnet."].exists)
        XCTAssertTrue(figures.waitForExistence(timeout: 30))
        shot(app, "9-opened")

        // two Zwischenstopps, each added from its search by a tap on the map; their grips show that they change places
        // when held and dragged
        // below the route, which the opened route leaves free
        let spots = [CGVector(dx: 0.25, dy: 0.55), CGVector(dx: 0.6, dy: 0.6), CGVector(dx: 0.45, dy: 0.68), CGVector(dx: 0.75, dy: 0.45)]
        for (index, spot) in spots.enumerated() {
            panel(app, to: 0.1)
            // further down the list with each stop
            let add = app.buttons["Zwischenstopp hinzufügen"]
            for _ in 0..<4 where !add.isHittable { app.swipeUp() }
            add.tap()
            XCTAssertTrue(app.textFields["Zwischenstopp \(index + 1) suchen"].waitForExistence(timeout: 5))
            app.buttons["Auf der Karte wählen"].tap()
            XCTAssertTrue(app.staticTexts["Neuen Zwischenstopp \(index + 1) antippen"].waitForExistence(timeout: 5))
            // the tap once the panel has come down from full height, not on it
            let folded = NSPredicate { _, _ in grabber.frame.minY > app.frame.height * 0.6 }
            XCTAssertEqual(XCTWaiter.wait(for: [expectation(for: folded, evaluatedWith: nil)], timeout: 5), .completed, "the panel stayed up")
            app.coordinate(withNormalizedOffset: spot).tap()
            XCTAssertTrue(app.staticTexts["Neuen Zwischenstopp \(index + 1) antippen"].waitForNonExistence(timeout: 5))
        }
        panel(app, to: 0.1)
        let group = app.buttons.matching(NSPredicate(format: "label BEGINSWITH '4 Zwischenstopps'")).firstMatch
        XCTAssertTrue(group.waitForExistence(timeout: 10), "four Zwischenstopps not one row")
        shot(app, "10-grips")
        // four and more are one row, open after adding; a tap folds it
        group.tap()
        XCTAssertTrue(app.buttons["Zwischenstopp 1 entfernen"].waitForNonExistence(timeout: 5))
        shot(app, "11-grouped")
        // the four undone on the map, the panel folded
        panel(app, to: 0.98)
        for _ in 1...4 { history(app, "Rückgängig") }
        XCTAssertTrue(group.waitForNonExistence(timeout: 5))
        XCTAssertTrue(figures.waitForExistence(timeout: 30))

        // deleted again, so the test leaves "Meine Routen" as it found it
        panel(app, to: 0.1)
        app.buttons["Meine Routen"].tap()
        XCTAssertTrue(entry.waitForExistence(timeout: 5))
        delete(app, entry)
        XCTAssertTrue(entry.waitForNonExistence(timeout: 5), "Testrunde not deleted")
    }

    /// Moves a Formpunkt, reorders two Zwischenstopps around it, and renames, duplicates and deletes the route in
    /// "Meine Routen".
    @MainActor
    func testEditsStopsAndSavedRoutes() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["-fresh"]
        app.launch()
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

        // a Formpunkt dragged out of the route, landing where it rode above the finger, then held there and dragged
        // on; one undo puts it back
        let lift = 48 / app.frame.height
        map(0.567, 0.356).press(forDuration: 0.6, thenDragTo: map(0.52, 0.46))
        let shaped = distance(direct)
        sleep(1)
        map(0.52, 0.46 - lift).press(forDuration: 0.6, thenDragTo: map(0.42, 0.55))
        let moved = distance(shaped)
        shot(app, "e1-formpunkt-moved")
        history(app, "Rückgängig")
        XCTAssertEqual(distance(moved), shaped, "undo did not put the Formpunkt back")

        // two Zwischenstopps, the farther first, held and dragged into the other order; the Formpunkt keeps its place
        for (index, spot) in [(0.62, 0.2), (0.3, 0.22)].enumerated() {
            let before = figures.label
            panel(app, to: 0.1)
            let add = app.buttons["Zwischenstopp hinzufügen"]
            for _ in 0..<4 where !add.isHittable { app.swipeUp() }
            add.tap()
            app.buttons["Auf der Karte wählen"].tap()
            XCTAssertTrue(app.staticTexts["Neuen Zwischenstopp \(index + 1) antippen"].waitForExistence(timeout: 5))
            map(spot.0, spot.1).tap()
            _ = distance(before)
        }
        panel(app, to: 0.1)
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
        panel(app, to: 0.98)
        history(app, "Rückgängig")
        XCTAssertTrue(app.staticTexts[before].waitForExistence(timeout: 10), "undo did not restore the Start")
        XCTAssertTrue(figures.waitForExistence(timeout: 60))
        XCTAssertEqual(figures.label, ordered)
        panel(app, to: 0.1)
        XCTAssertEqual(name(app.buttons["Zwischenstopp 1 entfernen"]), names.0, "undo did not restore the order")

        // saved, then in "Meine Routen" renamed, which the open route takes on, duplicated, and the copy and then the
        // route itself deleted, which leaves the route open but no longer saved
        app.buttons["Weitere Aktionen"].tap()
        // the menu takes its taps once it has opened, which the moving map does not let the test wait for
        sleep(1)
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
        panel(app, to: 0.1)
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
        delete(app, entry(copy))
        XCTAssertTrue(entry(copy).waitForNonExistence(timeout: 5), "copy not deleted")
        XCTAssertTrue(entry(renamed).exists, "the original went with the copy")
        app.buttons["Route"].tap()
        XCTAssertTrue(app.staticTexts[renamed].waitForExistence(timeout: 5), "the open route kept its old name")
        app.buttons["Meine Routen"].tap()
        delete(app, entry(renamed))
        XCTAssertTrue(entry(renamed).waitForNonExistence(timeout: 5))
        app.buttons["Route"].tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS ' → '")).firstMatch.waitForExistence(timeout: 5),
                      "the deleted route's name still on the open route")
        XCTAssertEqual(figures.label, ordered, "the open route changed")
        shot(app, "e5-deleted")
    }

    /// Suggests loops from a Start, as a rider does: the distance on its slider and the climbing typed, nothing
    /// suggested before asked; the three loops in reach at half height, one chosen and taken as the route.
    @MainActor
    func testSuggestsLoops() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["-fresh"]
        app.launch()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Tipp:'")).firstMatch.waitForExistence(timeout: 60))
        sleep(2)
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.35)).tap()
        let open = app.buttons["Runde vorschlagen"]
        XCTAssertTrue(open.waitForExistence(timeout: 30), "no loops offered with only a Start")
        open.tap()
        let suggest = app.buttons["Runden vorschlagen"], take = app.buttons.matching(identifier: "Fahren")
        XCTAssertTrue(suggest.waitForExistence(timeout: 5))
        XCTAssertFalse(take.firstMatch.exists, "suggested before asked")
        // the distance on its slider, as a finger: the knob, inset by its half width, drawn to the left
        let distance = app.sliders["Distanz"]
        let knob = 14 / distance.frame.width
        distance.coordinate(withNormalizedOffset: CGVector(dx: knob + distance.normalizedSliderPosition * (1 - 2 * knob), dy: 0.5))
            .press(forDuration: 0.05, thenDragTo: distance.coordinate(withNormalizedOffset: CGVector(dx: 0.1, dy: 0.5)), withVelocity: .slow,
                   thenHoldForDuration: 0.2)
        XCTAssertNotEqual(app.textFields["Distanz"].value as? String, "80", "the slider did not move")
        // the climbing typed (a tap on its line selects the figure), and suggested at once, without leaving the field
        app.staticTexts["Höhenmeter"].tap()
        app.typeText("1000")
        suggest.tap()
        XCTAssertTrue(take.firstMatch.waitForExistence(timeout: 90), "no loops found")
        XCTAssertEqual(take.count, 3)
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label ENDSWITH 'km · 1.000 hm'")).firstMatch.exists, "the settings not folded")
        XCTAssertTrue(take.element(boundBy: 2).isHittable, "the third loop out of reach at half height")
        shot(app, "l1-loops")
        app.staticTexts.matching(NSPredicate(format: "label MATCHES '[0-9]+ km · .+ hm' AND NOT label ENDSWITH ' 1.000 hm'")).element(boundBy: 2).tap()
        shot(app, "l2-chosen")
        take.element(boundBy: 2).tap()
        XCTAssertTrue(take.firstMatch.waitForNonExistence(timeout: 5))
        let title = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Runde ab '")).firstMatch
        XCTAssertTrue(title.waitForExistence(timeout: 30), "the loop not the route")
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label ENDSWITH ' km'")).firstMatch.waitForExistence(timeout: 30))
        shot(app, "l3-taken")
        // one undo step back to the Start alone
        history(app, "Rückgängig")
        XCTAssertTrue(open.waitForExistence(timeout: 10))
    }

    /// Chooses the map as on Apple Maps' card: aerial photos with the map's names, the terrain map, the signed cycle
    /// routes over it, and back to the offline map.
    @MainActor
    func testChoosesTheMap() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["-fresh"]
        app.launch()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Tipp:'")).firstMatch.waitForExistence(timeout: 60))
        // a route, which stays over the online maps
        sleep(2)
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.25, dy: 0.3)).tap()
        sleep(1)
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.75, dy: 0.42)).tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label ENDSWITH ' km'")).firstMatch.waitForExistence(timeout: 60))
        app.buttons["Karte wählen"].tap()
        let aerial = app.buttons["Satellit"]
        XCTAssertTrue(aerial.waitForExistence(timeout: 5))
        aerial.tap()
        sleep(4)
        shot(app, "m1-aerial")
        app.buttons["Gelände"].tap()
        // the switch itself, at the card's right; the card keeps the tap from the map
        let routes = app.switches["Radrouten"]
        routes.coordinate(withNormalizedOffset: CGVector(dx: 0.92, dy: 0.5)).tap()
        XCTAssertEqual(routes.value as? String, "1")
        sleep(4)
        shot(app, "m2-terrain-routes")
        XCTAssertTrue(app.staticTexts["Kartendarstellung: © OpenTopoMap (CC-BY-SA) · SRTM\nRadrouten: Waymarked Trails (CC BY-SA)"].exists,
                      "the credits on the map")
        routes.coordinate(withNormalizedOffset: CGVector(dx: 0.92, dy: 0.5)).tap()
        // the card's empty heading row takes no tap through to the map: still no Start
        app.buttons["Karte schließen"].coordinate(withNormalizedOffset: CGVector(dx: -3, dy: 0.5)).tap()
        shot(app, "m3-card-tap")
        // a tap on the map would have gone on from the Ziel, making it Zwischenstopp 1
        XCTAssertFalse(app.buttons["Zwischenstopp 1 entfernen"].exists, "a tap on the card reached the map")
        app.buttons["Karte"].tap()
        app.buttons["Karte schließen"].tap()
        XCTAssertTrue(aerial.waitForNonExistence(timeout: 5))
    }

    /// The route and its Formpunkte under a finger as a person uses it, trembling a few points: a slow tap on the route
    /// adds a Zwischenstopp; dragged, the route takes a Formpunkt where it rode above the finger; held still on it and
    /// let go, nothing; held and then dragged, it moves; a quick swipe only pans.
    @MainActor
    func testTouchesTheRouteLikeAFinger() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["-fresh"]
        app.launch()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Tipp:'")).firstMatch.waitForExistence(timeout: 60))
        sleep(2)
        let spot = { (x: Double, y: Double) in app.coordinate(withNormalizedOffset: CGVector(dx: x, dy: y)) }
        let tremble = CGVector(dx: 4, dy: 5)
        let compass = app.buttons["LookAroundCompassView"]
        spot(0.25, 0.3).tap()
        sleep(1)
        spot(0.75, 0.42).tap()
        let figures = app.staticTexts.matching(NSPredicate(format: "label ENDSWITH ' km'")).firstMatch
        XCTAssertTrue(figures.waitForExistence(timeout: 60), "no route")
        let changed = { (before: String) -> String in
            let change = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == true AND label != %@", before), object: figures)
            XCTAssertEqual(XCTWaiter().wait(for: [change], timeout: 60), .completed, "the route still \(before)")
            return figures.label
        }
        let direct = figures.label

        // a slow tap on the route adds a Zwischenstopp (the same distance: it lies on the route); undone
        spot(0.567, 0.356).press(forDuration: 0.4, thenDragTo: spot(0.567, 0.356).withOffset(tremble))
        XCTAssertFalse(compass.waitForExistence(timeout: 2), "Street View from a slow tap on the route")
        panel(app, to: 0.1)
        XCTAssertTrue(app.buttons["Zwischenstopp 1 entfernen"].waitForExistence(timeout: 10), "a slow tap on the route added no Zwischenstopp")
        panel(app, to: 0.98)
        sleep(1)
        history(app, "Rückgängig")
        panel(app, to: 0.1)
        XCTAssertTrue(app.buttons["Zwischenstopp 1 entfernen"].waitForNonExistence(timeout: 10), "undo did not remove the Zwischenstopp")
        panel(app, to: 0.98)
        sleep(1)

        // dragged: a Formpunkt where it rode, above the finger
        let lift = 48 / app.frame.height
        spot(0.567, 0.356).press(forDuration: 0.3, thenDragTo: spot(0.52, 0.46))
        let shaped = changed(direct)
        sleep(1)

        // held still on the Formpunkt and let go: nothing
        spot(0.52, 0.46 - lift).press(forDuration: 0.9, thenDragTo: spot(0.52, 0.46 - lift).withOffset(tremble))
        XCTAssertFalse(compass.waitForExistence(timeout: 2), "Street View from a hold")
        sleep(2)
        XCTAssertEqual(figures.label, shaped, "holding the Formpunkt still moved it")

        // held, then dragged: the Formpunkt moves, no Street View
        spot(0.52, 0.46 - lift).press(forDuration: 0.9, thenDragTo: spot(0.42, 0.56))
        XCTAssertFalse(compass.waitForExistence(timeout: 2), "Street View after a drag")
        let moved = changed(shaped)
        shot(app, "f1-formpunkt-moved")

        // a quick swipe pans the map and changes nothing
        spot(0.3, 0.25).press(forDuration: 0.05, thenDragTo: spot(0.5, 0.3))
        XCTAssertFalse(compass.waitForExistence(timeout: 2), "Street View from a swipe")
        sleep(2)
        XCTAssertEqual(figures.label, moved, "a swipe changed the route")
    }

    /// Street View from its button, as on the planner: the hint, then a tap shows Apple's Look Around there full screen;
    /// closed, its pin stays, a tap on it shows it again, and the next tap elsewhere clears it and does its own job.
    /// The hint's "Abbrechen" leaves the map as it was.
    @MainActor
    func testShowsStreetView() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["-fresh"]
        app.launch()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Tipp:'")).firstMatch.waitForExistence(timeout: 60))
        sleep(2)
        let spot = { (x: Double, y: Double) in app.coordinate(withNormalizedOffset: CGVector(dx: x, dy: y)) }
        // Apple's viewer, in the simulator's language
        let compass = app.buttons["LookAroundCompassView"], close = app.buttons["Close"]
        let button = app.buttons["Street View"], hint = app.staticTexts["Street View: Ort antippen"]
        // the folded panel offers a loop while only the Start is set
        let started = app.buttons["Runde vorschlagen"]

        // cancelled: nothing happens
        button.tap()
        XCTAssertTrue(hint.waitForExistence(timeout: 5))
        app.buttons["Abbrechen"].tap()
        XCTAssertTrue(hint.waitForNonExistence(timeout: 5))
        spot(0.4, 0.45).tap()
        XCTAssertFalse(compass.waitForExistence(timeout: 2), "Street View after cancelling")
        XCTAssertTrue(started.waitForExistence(timeout: 10), "the tap after cancelling set no Start")
        history(app, "Rückgängig")

        // the button, then a tap: Look Around, turned by a drag
        button.tap()
        XCTAssertTrue(hint.waitForExistence(timeout: 5))
        shot(app, "s0-hint")
        spot(0.4, 0.45).tap()
        XCTAssertTrue(compass.waitForExistence(timeout: 10), "no Look Around")
        XCTAssertFalse(hint.exists, "the hint stayed")
        sleep(3)
        spot(0.85, 0.5).press(forDuration: 0.05, thenDragTo: spot(0.35, 0.5))
        sleep(2)
        shot(app, "s1-look-around")
        close.tap()
        XCTAssertTrue(compass.waitForNonExistence(timeout: 5))
        sleep(1)
        shot(app, "s2-pin")
        XCTAssertFalse(started.exists, "Street View set a stop")

        // a tap on the kept pin shows it again
        spot(0.4, 0.45).withOffset(CGVector(dx: 0, dy: -30)).tap()
        XCTAssertTrue(compass.waitForExistence(timeout: 10), "the pin did not show Street View again")
        close.tap()
        XCTAssertTrue(compass.waitForNonExistence(timeout: 5))

        // a tap elsewhere clears the pin and sets the Start
        spot(0.25, 0.3).tap()
        XCTAssertFalse(compass.waitForExistence(timeout: 2), "Street View from an ordinary tap")
        XCTAssertTrue(started.waitForExistence(timeout: 10), "the tap after Street View set no Start")
        sleep(1)
        shot(app, "s3-cleared")
    }

    /// Undo or redo as a rider does: on the map while it is offered there, else in the panel's menu.
    @MainActor
    private func history(_ app: XCUIApplication, _ label: String) {
        let onMap = app.buttons[label]
        if !(onMap.exists && onMap.isHittable) { app.buttons["Weitere Aktionen"].tap() }
        onMap.tap()
    }

    /// The panel dragged by its grabber to a height on the screen, from 0 (top) to 1.
    @MainActor
    private func panel(_ app: XCUIApplication, to y: Double) {
        app.buttons["Sheet Grabber"].coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            .press(forDuration: 0.2, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: y)))
    }

    /// A saved route deleted from "Meine Routen" by a swipe, confirmed.
    @MainActor
    private func delete(_ app: XCUIApplication, _ entry: XCUIElement) {
        entry.swipeLeft()
        app.buttons["Löschen"].tap()
        app.alerts.buttons["Endgültig löschen"].tap()
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
