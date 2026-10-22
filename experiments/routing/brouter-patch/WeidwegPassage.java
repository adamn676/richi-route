package btools.router;

public final class WeidwegPassage {
  static boolean matches(int lon1, int lat1, int lon2, int lat2) {
    return flight(lon1, lat1, lon2, lat2) || flight(lon2, lat2, lon1, lat1);
  }

  private static boolean flight(int lon1, int lat1, int lon2, int lat2) {
    return lon1 == 195397866 && lat1 == 137102550 && lon2 == 195397832 && lat2 == 137102537
      || lon1 == 195397639 && lat1 == 137102476 && lon2 == 195397607 && lat2 == 137102466;
  }

  public static float costfactor(float original, String tags) {
    String values = " " + tags + " ";
    if (original != 9999.f || !values.contains(" highway=steps ")
      || !values.contains(" bicycle=dismount ") || !values.contains(" foot=yes ")
      || !values.contains(" ramp:bicycle=yes ") || !values.contains(" surface=concrete ")
      || values.contains(" access=no ") || values.contains(" access=private ")
      || values.contains(" vehicle=no ") || values.contains(" vehicle=private ")
      || values.contains(" oneway=") || values.contains(" oneway:bicycle=")) return original;
    return 15.f;
  }
}
