package btools.router;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Random;

import btools.expressions.BExpressionContextWay;
import btools.expressions.BExpressionMetaData;
import btools.mapaccess.OsmNode;
import btools.mapaccess.TurnRestriction;

public final class LocalRoutingRulesTest {
  private static int checks;
  private static void check(boolean condition, String message) {
    checks++;
    if (!condition) throw new AssertionError(message);
  }
  private static RoutingContext context(LocalRoutingRules rules) throws Exception {
    RoutingContext rc = new RoutingContext();
    rc.bikeMode = true;
    rc.expctxWay = new BExpressionContextWay(16, new BExpressionMetaData());
    Path profile = Files.createTempFile("richiroute-rule-profile-", ".brf");
    try {
      Files.write(profile, "---context:global\nassign richiroute_local_rules = true\n---context:way\nassign costfactor = 1\n".getBytes(StandardCharsets.UTF_8));
      rc.expctxWay.parseFile(profile.toFile(), "global");
    } finally { Files.delete(profile); }
    rules.configure(rc);
    return rc;
  }
  private static LocalRoutingRules fixture(String body) throws Exception {
    Path file = Files.createTempFile("richiroute-rules-test-", ".tsv");
    try {
      Files.write(file, ("richiroute-rules\t1\t" + String.join("", java.util.Collections.nCopies(64, "a")) + "\n" + body).getBytes(StandardCharsets.UTF_8));
      return LocalRoutingRules.load(file.toString());
    } finally { Files.delete(file); }
  }
  private static TurnRestriction restriction() {
    TurnRestriction tr = new TurnRestriction();
    tr.fromLon = 195539580; tr.fromLat = 137102991;
    tr.toLon = 195538680; tr.toLat = 137103321;
    return tr;
  }
  private static boolean forbidden(LocalRoutingRules rules, OsmNode node, RoutingContext rc) {
    return rules.isTurnForbidden(node, 195539580, 137102991, 195538680, 137103321, rc);
  }
  public static void main(String[] args) throws Exception {
    LocalRoutingRules rules = LocalRoutingRules.load(args[0]);
    String tags = "highway=steps bicycle=dismount foot=yes ramp:bicycle=yes surface=concrete";
    LocalRoutingRules.Segment segment = rules.segment(195397866, 137102550, 195397832, 137102537);
    check(segment != null && segment.costfactor(9999.f, tags) == 15.f, "Existing passage");
    check(rules.segment(195397832, 137102537, 195397866, 137102550) != null, "Reverse passage");
    for (int i = 0; i < 4; i++) {
      int[] endpoint = {195397866, 137102550, 195397832, 137102537}; endpoint[i]++;
      check(rules.segment(endpoint[0], endpoint[1], endpoint[2], endpoint[3]) == null, "Changed geometry must not match");
    }
    for (String tag : tags.split(" ")) check(segment.costfactor(9999.f, tags.replace(tag, "")) == 9999.f, "Missing " + tag);
    for (String tag : new String[]{"access=no", "access=private", "vehicle=no", "vehicle=private", "oneway=yes", "oneway:bicycle=no"}) {
      check(segment.costfactor(9999.f, tags + " " + tag) == 9999.f, "Forbidden " + tag);
      check(!rules.mayAccess(tags + " " + tag), "Decode guard for " + tag);
    }
    check(segment.costfactor(120.f, tags) == 120.f && segment.costfactor(10000.f, tags) == 10000.f, "Other costs retained");
    LocalRoutingRules additional = fixture("guard\tother\thighway=steps;bicycle=dismount\taccess=private\t\t30\nsegment\tother\t196000000\t138000000\t196000001\t138000001\n");
    check(additional.segment(196000000, 138000000, 196000001, 138000001).costfactor(9999.f, tags) == 30.f, "A new rule needs only data");
    check(additional.segment(196000001, 138000001, 196000000, 138000000) == null, "Directed passage");
    check(fixture("").segment(195397866, 137102550, 195397832, 137102537) == null, "Empty registry removes old exception");

    RoutingContext rc = context(rules);
    OsmNode junction = new OsmNode(195539841, 137103009);
    TurnRestriction tr = restriction(); junction.addTurnRestriction(tr);
    check(tr.exceptions == 0, "Graph data has no hardcoded correction");
    check(!forbidden(rules, junction, rc), "Configured bicycle turn");
    check(tr.exceptions == 0, "Shared graph restriction is immutable");
    rc.carMode = true; rules.configure(rc);
    check(forbidden(rules, junction, rc), "Car mode cannot use bicycle exceptions");
    rc.carMode = false; rc.footMode = true; rules.configure(rc);
    check(forbidden(rules, junction, rc), "Mixed foot mode cannot use bicycle exceptions");
    rc.footMode = false; rc.expctxWay.setVariableValue("richiroute_local_rules", 0.f, false); rules.configure(rc);
    check(forbidden(rules, junction, rc), "Profile opt-out");
    rc = context(rules);
    junction.ilon++;
    check(forbidden(rules, junction, rc), "Changed junction");
    junction.ilon--;
    check(rules.isTurnForbidden(junction, tr.toLon, tr.toLat, tr.fromLon, tr.fromLat, rc)
      == TurnRestriction.isTurnForbidden(tr, tr.toLon, tr.toLat, tr.fromLon, tr.fromLat, true, false), "Reverse turn retained");
    TurnRestriction only = restriction(); only.isPositive = true; only.toLon++;
    junction.addTurnRestriction(only);
    check(forbidden(rules, junction, rc), "A different only-turn restriction still applies");
    rc.keyValues = new HashMap<>(); rc.keyValues.put("richiroute_rules_0", "0");
    try { rules.configure(rc); throw new AssertionError("Stale revision accepted"); }
    catch (IllegalArgumentException expected) { check(expected.getMessage().contains("version mismatch"), "Stale revision is reported"); }
    areaParity();
    System.out.println("Local routing rules: " + checks + " checks passed, including 100000 indexed circle comparisons.");
  }

  private static void areaParity() throws Exception {
    Random random = new Random(23102026);
    StringBuilder body = new StringBuilder();
    ArrayList<OsmNodeNamed> circles = new ArrayList<>();
    for (int i = 0; i < 100; i++) {
      OsmNodeNamed circle = new OsmNodeNamed();
      circle.ilon = 1000000 + random.nextInt(358000000);
      circle.ilat = 10000 + random.nextInt(179980000);
      circle.radius = .5 + random.nextDouble() * 9999.; circle.nogoWeight = 1 + random.nextInt(100); circle.isNogo = true;
      if (i == 1) { circle.ilon = circles.get(0).ilon; circle.ilat = circles.get(0).ilat; circle.radius = circles.get(0).radius * .8; }
      circles.add(circle);
      body.append("avoidance\ta").append(i).append('\t').append(circle.ilon).append('\t').append(circle.ilat)
        .append('\t').append(circle.radius).append('\t').append(circle.nogoWeight).append('\n');
    }
    LocalRoutingRules indexed = fixture(body.toString());
    RoutingContext actual = context(indexed), expected = new RoutingContext();
    for (int i = 0; i < 100000; i++) {
      OsmNodeNamed circle = circles.get(i % circles.size());
      int lon1 = circle.ilon + random.nextInt(400001) - 200000, lat1 = circle.ilat + random.nextInt(4001) - 2000;
      int lon2 = lon1 + random.nextInt(400001) - 200000, lat2 = lat1 + random.nextInt(4001) - 2000;
      lat1 = Math.max(1, Math.min(179999999, lat1)); lat2 = Math.max(1, Math.min(179999999, lat2));
      actual.nogoCost = expected.nogoCost = i % 3 == 0 ? 3.25 : 0.;
      actual.nogopoints = null; expected.nogopoints = new ArrayList<>(circles);
      actual.shortestmatch = expected.shortestmatch = false;
      actual.isEndpoint = expected.isEndpoint = i % 2 == 0;
      if (i % 5 == 0) {
        OsmNodeNamed a = new OsmNodeNamed(), b = new OsmNodeNamed();
        a.ilon = b.ilon = (lon1 + lon2) / 2; a.ilat = b.ilat = (lat1 + lat2) / 2;
        a.radius = b.radius = 20000;
        actual.setWaypoint(a, actual.isEndpoint); expected.setWaypoint(b, expected.isEndpoint);
      }
      int distance = actual.calcDistance(lon1, lat1, lon2, lat2);
      check(distance == expected.calcDistance(lon1, lat1, lon2, lat2), "Distance at " + i);
      check(Double.doubleToLongBits(actual.nogoCost) == Double.doubleToLongBits(expected.nogoCost), "Circle cost at " + i + ": " + actual.nogoCost + " / " + expected.nogoCost);
      check(actual.shortestmatch == expected.shortestmatch, "Snapping at " + i);
      if (i % 5 == 0) { actual.unsetWaypoint(); expected.unsetWaypoint(); }
    }
    OsmNodeNamed circle = circles.get(0);
    actual.cleanNogoList(Arrays.<OsmNode>asList(new OsmNode(circle.ilon, circle.ilat)));
    actual.nogoCost = 0;
    actual.calcDistance(circle.ilon - 1, circle.ilat, circle.ilon + 1, circle.ilat);
    check(actual.nogoCost == 0, "Deliberate waypoint inside preference circle remains possible");
    actual.restoreNogoList(); actual.nogoCost = 0;
    actual.calcDistance(circle.ilon - 1, circle.ilat, circle.ilon + 1, circle.ilat);
    check(actual.nogoCost > 0, "Avoidance restoration");
  }
}
