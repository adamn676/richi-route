package btools.router;

public final class WeidwegPassageTest {
  private static void check(boolean value, String message) {
    if (!value) throw new AssertionError(message);
  }

  public static void main(String[] args) {
    int[][] flights = {{195397866, 137102550, 195397832, 137102537}, {195397639, 137102476, 195397607, 137102466}};
    for (int[] f : flights) {
      check(WeidwegPassage.matches(f[0], f[1], f[2], f[3]), "Forward flight");
      check(WeidwegPassage.matches(f[2], f[3], f[0], f[1]), "Reverse flight");
      for (int i = 0; i < 4; i++) {
        int[] moved = f.clone();
        moved[i]++;
        check(!WeidwegPassage.matches(moved[0], moved[1], moved[2], moved[3]), "Changed endpoint");
      }
    }
    check(!WeidwegPassage.matches(flights[0][0], flights[0][1], flights[1][2], flights[1][3]), "Whole passage is not a flight");
    String tags = "highway=steps bicycle=dismount foot=yes ramp:bicycle=yes surface=concrete";
    check(WeidwegPassage.costfactor(9999.f, tags) == 15.f, "Accepted tags");
    for (String tag : tags.split(" ")) check(WeidwegPassage.costfactor(9999.f, tags.replace(tag, "")) == 9999.f, "Missing " + tag);
    for (String extra : new String[]{"access=no", "access=private", "vehicle=no", "vehicle=private", "oneway=yes", "oneway:bicycle=yes"}) {
      check(WeidwegPassage.costfactor(9999.f, tags + " " + extra) == 9999.f, "Restriction " + extra);
    }
    check(WeidwegPassage.costfactor(9999.f, tags.replace("concrete", "gravel")) == 9999.f, "Surface changed");
    check(WeidwegPassage.costfactor(9999.f, tags.replace("dismount", "no")) == 9999.f, "Bicycle access changed");
    check(WeidwegPassage.costfactor(10000.f, tags) == 10000.f, "Do not override other forbidden costs");
    check(WeidwegPassage.costfactor(120.f, tags) == 120.f, "Preserve another profile's cost");
    System.out.println("Weidweg endpoint and tag scope checks passed.");
  }
}
