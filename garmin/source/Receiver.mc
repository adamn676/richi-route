import Toybox.Communications;
import Toybox.Lang;
import Toybox.PersistedContent;
import Toybox.System;
import Toybox.WatchUi;

//! A course from the phone, stored as Garmin courses: the phone sends {"name", "track", "parts" => [{"name",
//! "size", "url"}, ...]}, and the Edge asks Garmin Connect on the phone to fetch each part's FIT file from the
//! phone app (`makeWebRequest` with a FIT response), which stores it as a course. `track` is latitude,
//! longitude, ... in 1e-5 degrees, to draw the route.
class Receiver {
    var name as String = "";
    var track as Array<Number>?;
    var parts as Array<Dictionary<String, Object?>> = [];
    var courses as Array<PersistedContent.Course> = [];
    var lines as Array<String> = [];

    private var _started as Number = 0;
    private var _results as Array<String> = [];
    private var _listener as Ignored = new Ignored();

    function initialize() {
        log("Bereit: im iPhone \"An Edge senden\" tippen");
    }

    function onPhone(message as Communications.PhoneAppMessage) as Void {
        receive(message.data);
        WatchUi.requestUpdate();
    }

    function onPhoneError(error as Communications.PhoneAppMessageError) as Void {
        log("Nachricht verloren, Fehler " + error + " (zu wenig Speicher)");
        WatchUi.requestUpdate();
    }

    function receive(message as Object?) as Void {
        var course = message instanceof Dictionary ? message as Dictionary<String, Object?> : {};
        var parts = course["parts"];
        if (!(parts instanceof Array) || parts.size() == 0) {
            log("Unbekannte Nachricht");
            return;
        }
        name = course["name"] as String;
        track = course["track"] as Array<Number>?;
        self.parts = parts as Array<Dictionary<String, Object?>>;
        courses = [];
        _results = [];
        log(name + ": " + parts.size() + (parts.size() == 1 ? " Teil" : " Teile"));
        fetch();
    }

    private function label() as String {
        return "Teil " + (courses.size() + 1) + "/" + parts.size();
    }

    private function fetch() as Void {
        var part = parts[courses.size()];
        log(label() + ": Abruf" + (System.getDeviceSettings().phoneConnected ? "" : " (Telefon nicht verbunden)"));
        _started = System.getTimer();
        try {
            Communications.makeWebRequest(part["url"] as String, null, {
                :method => Communications.HTTP_REQUEST_METHOD_GET,
                :responseType => Communications.HTTP_RESPONSE_CONTENT_TYPE_FIT
            }, method(:onFetched));
        } catch (e) {
            report(label() + ": Abruf abgelehnt: " + e.getErrorMessage());
            done();
        }
    }

    function onFetched(code as Number, data as Dictionary or String or PersistedContent.Iterator or Null) as Void {
        var seconds = (System.getTimer() - _started) / 1000.0;
        var course = null;
        if (code != 200) {
            report(label() + ": Antwort " + code + " nach " + seconds.format("%.1f") + " s");
        } else {
            var part = parts[courses.size()];
            var size = (part["size"] as Number or Long).toNumber();
            course = stored(data instanceof PersistedContent.Iterator ? data : null, part["name"] as String);
            report(label() + ": " + size + " B in " + seconds.format("%.1f") + " s = "
                + (size / (seconds > 0.001 ? seconds : 0.001)).format("%.0f") + " B/s, "
                + (course != null ? "gespeichert als \"" + course.getName() + "\"" : "kein Kurs gespeichert"));
        }
        if (course != null) {
            courses.add(course);
        }
        if (course != null && courses.size() < parts.size()) {
            fetch();
        } else {
            done();
        }
        WatchUi.requestUpdate();
    }

    private function done() as Void {
        if (courses.size() == parts.size()) {
            log("Alle Teile gespeichert; Tippen startet Teil 1");
        }
        tell(_results);
    }

    //! Sends the phone the results, once the fetches are over: a transmit may disturb a web request under way,
    //! and the simulator crashes on one without a phone on ADB.
    function tell(lines as Array<String>) as Void {
        Communications.transmit(lines as Array<Communications.TransmitType>, null, _listener);
    }

    //! The course a fetch stored: from what it returned, otherwise among the Edge's courses by the part's name.
    private function stored(items as PersistedContent.Iterator?, partName as String) as PersistedContent.Course? {
        if (items != null) {
            for (var item = items.next(); item != null; item = items.next()) {
                if (item instanceof PersistedContent.Course) {
                    return item;
                }
            }
        }
        var all = PersistedContent.getCourses();
        for (var item = all.next(); item != null; item = all.next()) {
            if (item.getName().equals(partName)) {
                return item as PersistedContent.Course;
            }
        }
        return null;
    }

    //! A line for the log here and, at the end, on the phone.
    private function report(line as String) as Void {
        log(line);
        _results.add(line);
    }

    function log(line as String) as Void {
        System.println(line);
        lines.add(line);
        if (lines.size() > 40) {
            lines = lines.slice(-40, null);
        }
    }
}

//! Lines sent to the phone are a courtesy: nothing to do when one does not arrive.
class Ignored extends Communications.ConnectionListener {
    function initialize() {
        ConnectionListener.initialize();
    }

    function onComplete() as Void {
    }

    function onError() as Void {
    }
}
