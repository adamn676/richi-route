import Toybox.Graphics;
import Toybox.Lang;
import Toybox.Math;
import Toybox.System;
import Toybox.WatchUi;

//! The course's name, the parts stored so far, its track, and the log, newest line at the bottom.
class ReceiverView extends WatchUi.View {
    private var _receiver as Receiver;

    function initialize(receiver as Receiver) {
        View.initialize();
        _receiver = receiver;
    }

    function onUpdate(dc as Dc) as Void {
        var receiver = _receiver;
        var width = dc.getWidth();
        var font = Graphics.FONT_XTINY;
        dc.setColor(Graphics.COLOR_BLACK, Graphics.COLOR_WHITE);
        dc.clear();
        var y = 4;
        var parts = receiver.parts.size();
        if (parts > 0) {
            dc.drawText(width / 2, y, Graphics.FONT_SMALL, receiver.name, Graphics.TEXT_JUSTIFY_CENTER);
            y += dc.getFontHeight(Graphics.FONT_SMALL) + 4;
            dc.drawRectangle(8, y, width - 16, 10);
            dc.fillRectangle(8, y, (width - 16) * receiver.courses.size() / parts, 10);
            y += 14;
        }
        var track = receiver.track;
        if (track != null && track.size() >= 4) {
            drawTrack(dc, track, 8, y, width - 16, 100);
            dc.setColor(Graphics.COLOR_BLACK, Graphics.COLOR_TRANSPARENT);
            y += 106;
        }
        drawLog(dc, receiver.lines, y, font);
    }

    //! The newest lines that fit below `top`, each wrapped to the screen's width.
    private function drawLog(dc as Dc, lines as Array<String>, top as Number, font as FontType) as Void {
        var width = dc.getWidth() - 8;
        var bottom = dc.getHeight();
        for (var i = lines.size() - 1; i >= 0; i--) {
            // null where not even one line fits
            var text = Graphics.fitTextToArea(lines[i], font, width, bottom - top, true);
            if (text == null) {
                return;
            }
            var height = dc.getTextDimensions(text, font)[1];
            if (bottom - height < top) {
                return;
            }
            bottom -= height;
            dc.drawText(4, bottom, font, text, Graphics.TEXT_JUSTIFY_LEFT);
        }
    }

    private function drawTrack(dc as Dc, track as Array<Number>, left as Number, top as Number, width as Number, height as Number) as Void {
        var minLat = track[0], maxLat = minLat, minLon = track[1], maxLon = minLon;
        for (var i = 2; i < track.size(); i += 2) {
            minLat = track[i] < minLat ? track[i] : minLat;
            maxLat = track[i] > maxLat ? track[i] : maxLat;
            minLon = track[i + 1] < minLon ? track[i + 1] : minLon;
            maxLon = track[i + 1] > maxLon ? track[i + 1] : maxLon;
        }
        // a degree of longitude is shorter than one of latitude, by the cosine of the latitude
        var stretch = Math.cos(Math.toRadians((minLat + maxLat) / 2.0e5));
        var spanX = (maxLon - minLon) * stretch + 1, spanY = maxLat - minLat + 1.0;
        var scale = width / spanX < height / spanY ? width / spanX : height / spanY;
        var x0 = left + (width - spanX * scale) / 2, y0 = top + (height + spanY * scale) / 2;
        dc.setColor(Graphics.COLOR_BLUE, Graphics.COLOR_TRANSPARENT);
        dc.setPenWidth(3);
        var x = x0 + (track[1] - minLon) * stretch * scale, y = y0 - (track[0] - minLat) * scale;
        for (var i = 2; i < track.size(); i += 2) {
            var nextX = x0 + (track[i + 1] - minLon) * stretch * scale, nextY = y0 - (track[i] - minLat) * scale;
            dc.drawLine(x, y, nextX, nextY);
            x = nextX;
            y = nextY;
        }
        dc.setPenWidth(1);
    }
}

//! A tap (or the enter key) starts the first part in Garmin's own navigation once all are stored.
class ReceiverDelegate extends WatchUi.BehaviorDelegate {
    private var _receiver as Receiver;

    function initialize(receiver as Receiver) {
        BehaviorDelegate.initialize();
        _receiver = receiver;
    }

    function onSelect() as Boolean {
        var courses = _receiver.courses;
        if (courses.size() == 0 || courses.size() < _receiver.parts.size()) {
            return false;
        }
        System.exitTo(courses[0].toIntent());
        return true;
    }
}
