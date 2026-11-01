import Toybox.Application;
import Toybox.Communications;
import Toybox.Lang;
import Toybox.WatchUi;

//! Receives a FIT course from the RichiRoute iPhone app and tries to store it as a Garmin course.
class RichiApp extends Application.AppBase {
    var receiver as Receiver;

    function initialize() {
        AppBase.initialize();
        receiver = new Receiver();
    }

    function onStart(state as Dictionary?) as Void {
        Communications.registerForPhoneAppMessages(receiver.method(:onPhone));
        if (Communications has :registerForPhoneAppMessageErrors) {
            Communications.registerForPhoneAppMessageErrors(receiver.method(:onPhoneError));
        }
    }

    function getInitialView() as [Views] or [Views, InputDelegates] {
        return [new ReceiverView(receiver), new ReceiverDelegate(receiver)];
    }
}
