package btools.router;

import java.io.IOException;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import btools.mapaccess.OsmNode;
import btools.mapaccess.TurnRestriction;
import btools.util.CheapRuler;

/** Immutable, indexed rules shared by the routing workers. */
public final class LocalRoutingRules {
  public static final class VersionMismatchException extends IllegalArgumentException {
    public VersionMismatchException() { super("local routing rules version mismatch"); }
  }

  public static final LocalRoutingRules INSTANCE = loadConfigured();
  public final String revision;
  private final String[] revisionParts = new String[4];
  private final Index segments;
  private final Index turns;
  private final Guard[] guards;
  private final AreaTree areas;

  private LocalRoutingRules(String revision, List<String[]> rows) {
    this.revision = revision;
    if (!revision.isEmpty()) for (int i = 0; i < 4; i++) revisionParts[i] = new BigInteger(revision.substring(i * 16, i * 16 + 16), 16).toString();
    segments = new Index(rows.size());
    turns = new Index(rows.size());
    Map<String, Guard> byId = new HashMap<>();
    Map<String, Guard> uniqueGuards = new LinkedHashMap<>();
    List<Area> areaList = new ArrayList<>();
    for (String[] row : rows) {
      switch (row[0]) {
        case "guard": {
          require(row, 6);
          Guard guard = new Guard(row[2], row[3], row[4], Float.parseFloat(row[5]));
          if (byId.put(row[1], guard) != null) throw new IllegalArgumentException("Duplicate rule guard");
          uniqueGuards.put(row[2] + "\t" + row[3] + "\t" + row[4], guard);
          break;
        }
        case "segment": {
          require(row, 6);
          Guard guard = byId.get(row[1]);
          if (guard == null) throw new IllegalArgumentException("Missing rule guard");
          Segment segment = new Segment(row, guard);
          long key = pairKey(segment.from, segment.to);
          segment.next = (Segment) segments.get(key);
          segments.put(key, segment);
          break;
        }
        case "turn": {
          require(row, 8);
          Turn turn = new Turn(row);
          turn.next = (Turn) turns.get(turn.via);
          turns.put(turn.via, turn);
          break;
        }
        case "avoidance":
          require(row, 6);
          areaList.add(new Area(row, areaList.size()));
          break;
        default: throw new IllegalArgumentException("Unknown local rule record: " + row[0]);
      }
    }
    guards = uniqueGuards.values().toArray(new Guard[0]);
    areas = AreaTree.build(areaList.toArray(new Area[0]), 0, areaList.size());
  }

  private static void require(String[] row, int length) {
    if (row.length != length) throw new IllegalArgumentException("Malformed local rule record");
  }

  public static LocalRoutingRules load(String file) throws IOException {
    List<String> lines = Files.readAllLines(Paths.get(file), StandardCharsets.UTF_8);
    if (lines.isEmpty()) throw new IllegalArgumentException("Empty local rule file");
    String[] header = lines.remove(0).split("\t", -1);
    if (header.length != 3 || !header[0].equals("richiroute-rules") || !header[1].equals("1")
      || !header[2].matches("[a-f0-9]{64}")) throw new IllegalArgumentException("Unsupported local rule file");
    List<String[]> rows = new ArrayList<>();
    for (String line : lines) if (!line.isEmpty()) rows.add(line.split("\t", -1));
    return new LocalRoutingRules(header[2], rows);
  }

  private static LocalRoutingRules loadConfigured() {
    String file = System.getProperty("richiroute.rules");
    if (file == null) return new LocalRoutingRules("", Collections.<String[]>emptyList());
    try { return load(file); }
    catch (IOException e) { throw new IllegalStateException("Cannot load local routing rules: " + file, e); }
  }

  public void configure(RoutingContext rc) {
    rc.localRulesEnabled = rc.bikeMode && !rc.carMode && !rc.footMode
      && rc.expctxWay.getVariableValue("richiroute_local_rules", 0.f) == 1.f;
    if (rc.localRulesEnabled) {
      if (revision.isEmpty()) throw new VersionMismatchException();
      boolean versioned = false;
      if (rc.keyValues != null) for (int i = 0; i < 4; i++) versioned |= rc.keyValues.containsKey("richiroute_rules_" + i);
      if (versioned) for (int i = 0; i < 4; i++) {
        if (!revisionParts[i].equals(rc.keyValues.get("richiroute_rules_" + i))) throw new VersionMismatchException();
      }
    }
    rc.localAreas = rc.localRulesEnabled && areas != null ? new ActiveAreas(areas) : null;
  }

  public boolean mayAccess(String tags) {
    String values = " " + tags + " ";
    for (Guard guard : guards) if (guard.matches(values)) return true;
    return false;
  }

  public Segment segment(int lon1, int lat1, int lon2, int lat2) {
    long from = nodeKey(lon1, lat1), to = nodeKey(lon2, lat2);
    for (Segment segment = (Segment) segments.get(pairKey(from, to)); segment != null; segment = segment.next) {
      if (segment.from == from && segment.to == to) return segment;
    }
    return null;
  }

  public boolean isTurnForbidden(OsmNode node, int fromLon, int fromLat, int toLon, int toLat, RoutingContext rc) {
    TurnRestriction original = node.firstRestriction;
    if (original == null) return false;
    if (rc.localRulesEnabled) {
      long from = nodeKey(fromLon, fromLat), to = nodeKey(toLon, toLat);
      for (Turn turn = (Turn) turns.get(nodeKey(node.ilon, node.ilat)); turn != null; turn = turn.next) {
        if (turn.from != from || turn.to != to) continue;
        // Never mutate shared graph restrictions or remove a different restriction at this junction.
        TurnRestriction head = null, tail = null;
        for (TurnRestriction tr = original; tr != null; tr = tr.next) {
          TurnRestriction copy = new TurnRestriction();
          copy.isPositive = tr.isPositive;
          copy.exceptions = tr.exceptions;
          copy.fromLon = tr.fromLon; copy.fromLat = tr.fromLat;
          copy.toLon = tr.toLon; copy.toLat = tr.toLat;
          if (!tr.isPositive && fromLon == tr.fromLon && fromLat == tr.fromLat && toLon == tr.toLon && toLat == tr.toLat) copy.exceptions |= 1;
          if (tail == null) head = copy; else tail.next = copy;
          tail = copy;
        }
        original = head;
        break;
      }
    }
    return TurnRestriction.isTurnForbidden(original, fromLon, fromLat, toLon, toLat, rc.bikeMode || rc.footMode, rc.carMode);
  }

  static long nodeKey(int lon, int lat) { return ((long) lon << 32) | (lat & 0xffffffffL); }
  private static long mix(long value) {
    value ^= value >>> 33;
    value *= 0xff51afd7ed558ccdL;
    value ^= value >>> 33;
    value *= 0xc4ceb9fe1a85ec53L;
    return value ^ value >>> 33;
  }
  private static long pairKey(long from, long to) { return mix(from) ^ Long.rotateLeft(mix(to), 23); }
  private static long coord(String[] row, int index) { return nodeKey(Integer.parseInt(row[index]), Integer.parseInt(row[index + 1])); }

  private static final class Index {
    final long[] keys;
    final Object[] values;
    final int mask;
    Index(int size) {
      int capacity = 4;
      while (capacity < size * 2) capacity <<= 1;
      keys = new long[capacity]; values = new Object[capacity]; mask = capacity - 1;
    }
    Object get(long key) {
      int i = (int) mix(key) & mask;
      while (values[i] != null && keys[i] != key) i = (i + 1) & mask;
      return values[i];
    }
    void put(long key, Object value) {
      int i = (int) mix(key) & mask;
      while (values[i] != null && keys[i] != key) i = (i + 1) & mask;
      keys[i] = key; values[i] = value;
    }
  }

  public static final class Segment {
    final long from, to;
    final Guard guard;
    Segment next;
    Segment(String[] row, Guard guard) { from = coord(row, 2); to = coord(row, 4); this.guard = guard; }
    public float costfactor(float original, String tags) {
      return original == 9999.f && guard.matches(" " + tags + " ") ? guard.costfactor : original;
    }
  }

  private static final class Guard {
    final String[] required, forbidden, absent;
    final float costfactor;
    Guard(String required, String forbidden, String absent, float costfactor) {
      this.required = tokens(required, true); this.forbidden = tokens(forbidden, true); this.absent = tokens(absent, false);
      if (!Float.isFinite(costfactor) || costfactor < 1 || costfactor >= 9999) throw new IllegalArgumentException("Invalid local passage cost");
      this.costfactor = costfactor;
    }
    private static String[] tokens(String text, boolean value) {
      if (text.isEmpty()) return new String[0];
      String[] tokens = text.split(";");
      for (int i = 0; i < tokens.length; i++) tokens[i] = " " + tokens[i] + (value ? " " : "=");
      return tokens;
    }
    boolean matches(String tags) {
      for (String token : required) if (!tags.contains(token)) return false;
      for (String token : forbidden) if (tags.contains(token)) return false;
      for (String token : absent) if (tags.contains(token)) return false;
      return true;
    }
  }

  private static final class Turn {
    final long via, from, to;
    Turn next;
    Turn(String[] row) { via = coord(row, 2); from = coord(row, 4); to = coord(row, 6); }
  }

  private static final class Area {
    final OsmNodeNamed circle = new OsmNodeNamed();
    final int id, minLon, maxLon, minLat, maxLat;
    Area(String[] row, int id) {
      this.id = id;
      circle.ilon = Integer.parseInt(row[2]); circle.ilat = Integer.parseInt(row[3]);
      circle.radius = Double.parseDouble(row[4]); circle.nogoWeight = Double.parseDouble(row[5]); circle.isNogo = true;
      if (!Double.isFinite(circle.radius) || circle.radius <= 0 || circle.radius > 10000
        || !Double.isFinite(circle.nogoWeight) || circle.nogoWeight <= 0) throw new IllegalArgumentException("Invalid local avoidance penalty");
      // Conservative envelopes; the exact upstream circle calculation decides intersections.
      int latMargin = (int) Math.ceil((circle.radius + 2.) / .05);
      minLat = Math.max(0, circle.ilat - latMargin); maxLat = Math.min(180000000, circle.ilat + latMargin);
      double scale = Math.min(CheapRuler.getLonLatToMeterScales(minLat)[0], CheapRuler.getLonLatToMeterScales(maxLat)[0]);
      int lonMargin = (int) Math.min(360000000., Math.ceil((circle.radius + 2.) / Math.max(1e-12, scale) * 2.));
      minLon = Math.max(0, circle.ilon - lonMargin); maxLon = Math.min(360000000, circle.ilon + lonMargin);
    }
    boolean apply(RoutingContext rc, int lon1, int lat1, int lon2, int lat2, double d, double sx, double sy) {
      double dx = (lon2 - lon1) * sx, dy = (lat2 - lat1) * sy;
      double x1 = (lon1 - circle.ilon) * sx, y1 = (lat1 - circle.ilat) * sy;
      double x2 = (lon2 - circle.ilon) * sx, y2 = (lat2 - circle.ilat) * sy;
      double r12 = x1 * x1 + y1 * y1, r22 = x2 * x2 + y2 * y2;
      double radius = Math.abs(r12 < r22 ? y1 * dx - x1 * dy : y2 * dx - x2 * dy) / d;
      if (radius >= circle.radius) return false;
      double s1 = x1 * dx + y1 * dy, s2 = x2 * dx + y2 * dy;
      if (s1 < 0.) { s1 = -s1; s2 = -s2; }
      if (s2 > 0. && Math.sqrt(s1 < s2 ? r12 : r22) > circle.radius) return false;
      rc.nogoCost = circle.distanceWithinRadius(lon1, lat1, lon2, lat2, d) * circle.nogoWeight;
      return true;
    }
  }

  public static final class ActiveAreas {
    private static final int CELL = 20000;
    private static final Area[] EMPTY = new Area[0];
    private final AreaTree tree;
    private final Set<Integer> excluded = new HashSet<>();
    private final long[] cellKeys;
    private final Area[][] cellAreas;
    private int matchedOrder;
    ActiveAreas(AreaTree tree) {
      this.tree = tree;
      cellKeys = tree.count > 16 ? new long[1024] : null;
      cellAreas = tree.count > 16 ? new Area[1024][] : null;
    }
    public void clean(List<OsmNode> waypoints) {
      excluded.clear();
      for (OsmNode point : waypoints) tree.exclude(point, excluded);
    }
    public void restore() { excluded.clear(); }
    public void apply(RoutingContext rc, int lon1, int lat1, int lon2, int lat2, double d, double sx, double sy) {
      matchedOrder = -1;
      if (cellAreas == null) tree.apply(this, rc, lon1, lat1, lon2, lat2, d, sx, sy);
      else applyIndexed(rc, lon1, lat1, lon2, lat2, d, sx, sy);
    }
    private void applyIndexed(RoutingContext rc, int lon1, int lat1, int lon2, int lat2, double d, double sx, double sy) {
      if (!tree.intersects(lon1, lat1, lon2, lat2)) return;
      int x1 = Math.min(lon1, lon2) / CELL, x2 = Math.max(lon1, lon2) / CELL;
      int y1 = Math.min(lat1, lat2) / CELL, y2 = Math.max(lat1, lat2) / CELL;
      if (x2 - x1 > 1 || y2 - y1 > 1) {
        tree.apply(this, rc, lon1, lat1, lon2, lat2, d, sx, sy);
        return;
      }
      // Nearby graph edges reuse the same spatial query. The bounded cache belongs to this request.
      for (int x = x1; x <= x2; x++) for (int y = y1; y <= y2; y++) {
        long key = nodeKey(x, y);
        int slot = (int) mix(key) & (cellAreas.length - 1);
        Area[] candidates = cellAreas[slot];
        if (candidates == null || cellKeys[slot] != key) {
          ArrayList<Area> found = new ArrayList<>();
          tree.collect(found, x * CELL, y * CELL, (x + 1) * CELL, (y + 1) * CELL);
          candidates = found.isEmpty() ? EMPTY : found.toArray(new Area[0]);
          cellKeys[slot] = key; cellAreas[slot] = candidates;
        }
        for (Area area : candidates) {
          if (area.id <= matchedOrder || lon1 < area.minLon && lon2 < area.minLon || lon1 > area.maxLon && lon2 > area.maxLon
            || lat1 < area.minLat && lat2 < area.minLat || lat1 > area.maxLat && lat2 > area.maxLat) continue;
          if (!excluded.contains(area.id) && area.apply(rc, lon1, lat1, lon2, lat2, d, sx, sy)) matchedOrder = area.id;
        }
      }
    }
  }

  private static final class AreaTree {
    int minLon = Integer.MAX_VALUE, minLat = Integer.MAX_VALUE, maxLon, maxLat, count;
    Area area;
    AreaTree left, right;
    static AreaTree build(Area[] values, int from, int to) {
      if (from == to) return null;
      AreaTree tree = new AreaTree();
      tree.count = to - from;
      for (int i = from; i < to; i++) {
        Area area = values[i];
        tree.minLon = Math.min(tree.minLon, area.minLon); tree.maxLon = Math.max(tree.maxLon, area.maxLon);
        tree.minLat = Math.min(tree.minLat, area.minLat); tree.maxLat = Math.max(tree.maxLat, area.maxLat);
      }
      if (to - from == 1) tree.area = values[from];
      else {
        boolean longitude = tree.maxLon - tree.minLon > tree.maxLat - tree.minLat;
        Arrays.sort(values, from, to, Comparator.comparingInt(a -> longitude ? a.circle.ilon : a.circle.ilat));
        int middle = (from + to) >>> 1;
        tree.left = build(values, from, middle); tree.right = build(values, middle, to);
      }
      return tree;
    }
    boolean intersects(int lon1, int lat1, int lon2, int lat2) {
      return !(lon1 < minLon && lon2 < minLon || lon1 > maxLon && lon2 > maxLon
        || lat1 < minLat && lat2 < minLat || lat1 > maxLat && lat2 > maxLat);
    }
    void exclude(OsmNode point, Set<Integer> excluded) {
      if (!intersects(point.ilon, point.ilat, point.ilon, point.ilat)) return;
      if (area != null) {
        if (point.calcDistance(area.circle) < area.circle.radius) excluded.add(area.id);
      } else { left.exclude(point, excluded); right.exclude(point, excluded); }
    }
    void collect(List<Area> found, int minLon, int minLat, int maxLon, int maxLat) {
      if (!intersects(minLon, minLat, maxLon, maxLat)) return;
      if (area != null) found.add(area);
      else { left.collect(found, minLon, minLat, maxLon, maxLat); right.collect(found, minLon, minLat, maxLon, maxLat); }
    }
    void apply(ActiveAreas active, RoutingContext rc, int lon1, int lat1, int lon2, int lat2, double d, double sx, double sy) {
      if (!intersects(lon1, lat1, lon2, lat2)) return;
      if (area != null) {
        if (area.id > active.matchedOrder && !active.excluded.contains(area.id)
          && area.apply(rc, lon1, lat1, lon2, lat2, d, sx, sy)) active.matchedOrder = area.id;
      } else {
        left.apply(active, rc, lon1, lat1, lon2, lat2, d, sx, sy);
        right.apply(active, rc, lon1, lat1, lon2, lat2, d, sx, sy);
      }
    }
  }
}
