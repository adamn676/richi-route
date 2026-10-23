package btools.router;

import java.util.ArrayList;
import java.util.Random;

public class DistanceParity {
  private static void equal(double a, double b, String name) {
    if (Double.doubleToLongBits(a) != Double.doubleToLongBits(b)) throw new AssertionError(name + " differs: " + a + " / " + b);
  }

  public static void main(String[] args) {
    Random random = new Random(967334);
    RoutingContext actual = new RoutingContext();
    RoutingContext reference = new RoutingContext();
    int checked = 0;
    for (int i = 0; i < 1000000; i++) {
      int lon1 = 1000000 + random.nextInt(358000000);
      int lat1 = 1000000 + random.nextInt(178000000);
      int lon2 = lon1 + random.nextInt(200001) - 100000;
      int lat2 = lat1 + random.nextInt(200001) - 100000;
      actual.nogopoints = new ArrayList<>();
      reference.nogopoints = new ArrayList<>();
      for (int n = 0; n < 3; n++) {
        OsmNodeNamed a = new OsmNodeNamed();
        OsmNodeNamed b = new OsmNodeNamed();
        a.ilon = b.ilon = lon1 + random.nextInt(300001) - 150000;
        a.ilat = b.ilat = lat1 + random.nextInt(300001) - 150000;
        a.radius = b.radius = random.nextDouble() * (i % 4 == 0 ? 20000 : 10);
        a.isNogo = b.isNogo = random.nextBoolean();
        a.nogoWeight = b.nogoWeight = random.nextBoolean() ? Double.NaN : 50;
        actual.nogopoints.add(a);
        reference.nogopoints.add(b);
      }
      actual.isEndpoint = reference.isEndpoint = random.nextBoolean();
      actual.nogoCost = reference.nogoCost = 0;
      actual.shortestmatch = reference.shortestmatch = false;
      actual.ilonshortest = reference.ilonshortest = -1;
      actual.ilatshortest = reference.ilatshortest = -1;
      actual.wayfraction = reference.wayfraction = -1;
      int a = actual.calcDistance(lon1, lat1, lon2, lat2);
      int b = ReferenceRoutingContext.calcDistance(reference, lon1, lat1, lon2, lat2);
      if (a != b || actual.shortestmatch != reference.shortestmatch
        || actual.ilonshortest != reference.ilonshortest || actual.ilatshortest != reference.ilatshortest) throw new AssertionError("Geometry differs at " + i);
      equal(actual.nogoCost, reference.nogoCost, "Nogo cost");
      equal(actual.wayfraction, reference.wayfraction, "Way fraction");
      for (int n = 0; n < 3; n++) equal(actual.nogopoints.get(n).radius, reference.nogopoints.get(n).radius, "Radius");
      checked++;
    }
    System.out.println("Identical distances, avoidance costs, snapping and state in " + checked + " geographic cases.");
  }
}
