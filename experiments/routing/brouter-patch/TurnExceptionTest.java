import btools.mapaccess.OsmNode;
import btools.mapaccess.TurnRestriction;

public final class TurnExceptionTest {
  private static TurnRestriction restriction() {
    TurnRestriction tr = new TurnRestriction();
    tr.fromLon = 195539580;
    tr.fromLat = 137102991;
    tr.toLon = 195538680;
    tr.toLat = 137103321;
    return tr;
  }

  private static void check(boolean value, String message) {
    if (!value) throw new AssertionError(message);
  }

  private static boolean forbidden(TurnRestriction tr, boolean bike) {
    return TurnRestriction.isTurnForbidden(tr, tr.fromLon, tr.fromLat, tr.toLon, tr.toLat, bike, !bike);
  }

  public static void main(String[] args) {
    OsmNode junction = new OsmNode(195539841, 137103009);
    TurnRestriction corrected = restriction();
    junction.addTurnRestriction(corrected);
    check(!forbidden(corrected, true), "Reported bicycle turn must be permitted");
    check(forbidden(corrected, false), "Motorcar restriction must remain");

    for (int field = 0; field < 6; field++) {
      OsmNode node = new OsmNode(195539841, 137103009);
      TurnRestriction tr = restriction();
      if (field == 0) node.ilon++;
      if (field == 1) node.ilat++;
      if (field == 2) tr.fromLon++;
      if (field == 3) tr.fromLat++;
      if (field == 4) tr.toLon++;
      if (field == 5) tr.toLat++;
      node.addTurnRestriction(tr);
      check(forbidden(tr, true), "Other node or directed turn must remain restricted: " + field);
    }

    TurnRestriction reverse = restriction();
    reverse.fromLon = 195538680;
    reverse.fromLat = 137103321;
    reverse.toLon = 195539580;
    reverse.toLat = 137102991;
    junction.addTurnRestriction(reverse);
    check(forbidden(reverse, true), "Opposite turn must remain unchanged");

    TurnRestriction positive = restriction();
    positive.isPositive = true;
    junction.addTurnRestriction(positive);
    check(!positive.exceptBikes(), "Only-turn restrictions must remain unchanged");

    TurnRestriction existing = restriction();
    existing.exceptions = 2;
    junction.addTurnRestriction(existing);
    check(existing.exceptions == 3, "Existing exception bits must be preserved");
    check(existing.next == positive, "Original restriction-list insertion must remain intact");
    TurnRestriction alreadyExcepted = restriction();
    alreadyExcepted.exceptions = 1;
    junction.addTurnRestriction(alreadyExcepted);
    check(alreadyExcepted.exceptions == 1, "Existing bicycle exception must not acquire other mode bits");
    System.out.println("Bicycle exception scope checks passed (13 assertions).");
  }
}
