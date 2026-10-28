import java.io.BufferedOutputStream;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileReader;
import java.io.PrintStream;
import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.Set;

import btools.codec.MicroCache;
import btools.expressions.BExpressionContextWay;
import btools.expressions.BExpressionMetaData;
import btools.mapaccess.GeometryDecoder;
import btools.mapaccess.MatchedWaypoint;
import btools.mapaccess.NodesCache;
import btools.mapaccess.OsmLink;
import btools.mapaccess.OsmLinkHolder;
import btools.mapaccess.OsmNode;
import btools.mapaccess.OsmNodePairSet;
import btools.mapaccess.OsmNodesMap;
import btools.mapaccess.OsmTransferNode;
import btools.mapaccess.TurnRestriction;
import btools.util.SortedHeap;

/**
 * Reference dump for the data layer (util, codec, mapaccess). The Rust counterpart is
 * mapaccess/examples/data_parity.rs and must print the same text. Run with the test-double way context
 * on the classpath: data-shadow:pristine:brouter.jar:data.
 *
 * Usage: DataDump decode|decode-mc|match <segmentDir> <lookups.dat> [full]
 *        DataDump decode-real <segmentDir> <profile.brf> [full]
 *        DataDump heap
 *        DataDump ruler
 *
 * decode-real uses the real way context and profile, so it must run without data-shadow on the
 * classpath (pristine:brouter.jar:data); its Rust side uses the brouter-expressions profile.
 *
 * Every section ends with a digest line over its canonical text; sections are printed in full only
 * for a sample of positions unless "full" is given.
 */
public final class DataDump {
  static final long MAXMEM = 128L * 1024 * 1024;
  static final PrintStream out = new PrintStream(new BufferedOutputStream(System.out, 1 << 16), false, StandardCharsets.UTF_8);

  static long fnv;
  static int lines;
  static boolean detail;

  static void begin(boolean d) {
    fnv = 0xcbf29ce484222325L;
    lines = 0;
    detail = d;
  }

  static void line(String s) {
    if (detail) out.println(s);
    for (byte b : (s + "\n").getBytes(StandardCharsets.UTF_8)) {
      fnv ^= b & 0xff;
      fnv *= 0x100000001b3L;
    }
    lines++;
  }

  static void end(String name) {
    out.println("D " + name + " lines=" + lines + " fnv=" + Long.toHexString(fnv));
  }

  public static void main(String[] args) throws Exception {
    String mode = args[0];
    boolean full = args.length > 3 && args[3].equals("full");
    switch (mode) {
      case "heap":
        heap();
        break;
      case "ruler":
        ruler();
        break;
      case "decode-real":
        decode(new File(args[1]), realProfile(new File(args[2])), full, false, realPositions());
        break;
      default:
        File segDir = new File(args[1]);
        BExpressionContextWay ctx = validator(new File(args[2]));
        if (mode.equals("decode")) decode(segDir, ctx, full, false, decodePositions(false));
        else if (mode.equals("decode-mc")) decode(segDir, ctx, full, true, decodePositions(true));
        else if (mode.equals("match")) match(segDir, ctx, full);
        else throw new IllegalArgumentException("unknown mode " + mode);
    }
    out.flush();
  }

  static BExpressionContextWay validator(File lookups) throws Exception {
    BExpressionMetaData meta = new BExpressionMetaData();
    try (BufferedReader br = new BufferedReader(new FileReader(lookups))) {
      for (String l = br.readLine(); l != null; l = br.readLine()) {
        if (l.startsWith("---lookupversion:")) meta.lookupVersion = Short.parseShort(l.substring(17).trim());
        if (l.startsWith("---minorversion:")) meta.lookupMinorVersion = Short.parseShort(l.substring(16).trim());
      }
    }
    return new BExpressionContextWay(meta);
  }

  /** The planner's way context, loaded as RoutingEngine does (ProfileCache). */
  static BExpressionContextWay realProfile(File profile) {
    btools.router.RoutingContext rc = new btools.router.RoutingContext();
    rc.localFunction = profile.getPath();
    rc.memoryclass = 128;
    btools.router.ProfileCache.parseProfile(rc);
    return rc.expctxWay;
  }

  // ------------------------------------------------------------------ formatting

  static String hex(byte[] ab) {
    if (ab == null) return "-";
    StringBuilder sb = new StringBuilder();
    for (byte b : ab) sb.append(String.format("%02x", b & 0xff));
    return sb.toString();
  }

  static String pos(OsmNode n) {
    return n == null ? "-" : n.ilon + "," + n.ilat;
  }

  static String bits(double d) {
    return Long.toHexString(Double.doubleToRawLongBits(d));
  }

  // ------------------------------------------------------------------ positions

  static List<int[]> decodePositions(boolean mc) {
    List<int[]> list = new ArrayList<>();
    Random rnd = new Random(mc ? 4242 : 1234);
    int nrandom = mc ? 60 : 220;
    for (int i = 0; i < nrandom; i++) {
      list.add(new int[]{190000000 + rnd.nextInt(10000000), 135000000 + rnd.nextInt(5000000)});
    }
    int ndense = mc ? 3 : 5;
    int[][] centers = {{195430000, 137070000}, {196370000, 138210000}}; // Graz, Vienna
    for (int[] c : centers) {
      for (int a = 0; a < ndense; a++) {
        for (int b = 0; b < ndense; b++) {
          list.add(new int[]{c[0] + (a - ndense / 2) * 10000, c[1] + (b - ndense / 2) * 10000});
        }
      }
    }
    return list;
  }

  /** A handful of positions for the real-profile dump: Graz and Vienna, plus a few random ones. */
  static List<int[]> realPositions() {
    List<int[]> list = new ArrayList<>();
    int[][] centers = {{195430000, 137070000}, {196370000, 138210000}};
    for (int[] c : centers) {
      for (int a = -1; a <= 1; a++) list.add(new int[]{c[0] + a * 10000, c[1] - a * 10000});
    }
    Random rnd = new Random(31337);
    for (int i = 0; i < 6; i++) list.add(new int[]{190000000 + rnd.nextInt(10000000), 135000000 + rnd.nextInt(5000000)});
    return list;
  }

  // ------------------------------------------------------------------ graph dump

  @SuppressWarnings("unchecked")
  static List<OsmNode> indexed(OsmNodesMap nm) throws Exception {
    Field f = OsmNodesMap.class.getDeclaredField("hmap");
    f.setAccessible(true);
    return new ArrayList<>(((Map<OsmNode, OsmNode>) f.get(nm)).values());
  }

  static int compareId(OsmNode a, OsmNode b) {
    return Long.compare(a.getIdFromPos(), b.getIdFromPos());
  }

  /** All nodes reachable from the indexed nodes and the given seeds, sorted by id (stable). */
  static List<OsmNode> reachable(NodesCache nc, List<OsmNode> seeds) throws Exception {
    Set<OsmNode> seen = Collections.newSetFromMap(new IdentityHashMap<>());
    List<OsmNode> order = new ArrayList<>();
    ArrayDeque<OsmNode> queue = new ArrayDeque<>();
    List<OsmNode> all = indexed(nc.nodesMap);
    all.addAll(seeds);
    for (OsmNode n : all) {
      if (seen.add(n)) {
        order.add(n);
        queue.add(n);
      }
    }
    while (!queue.isEmpty()) {
      OsmNode n = queue.poll();
      for (OsmLink l = n.firstlink; l != null; l = l.getNext(n)) {
        OsmNode t = l.getTarget(n);
        if (seen.add(t)) {
          order.add(t);
          queue.add(t);
        }
      }
    }
    order.sort(DataDump::compareId);
    return order;
  }

  static String nodeLine(OsmNode n) {
    StringBuilder sb = new StringBuilder("N ").append(pos(n));
    sb.append(" e=").append(n.selev).append(" v=").append(n.visitID).append(" h=").append(n.isHollow() ? 1 : 0);
    sb.append(" d=").append(hex(n.nodeDescription)).append(" t=");
    for (TurnRestriction tr = n.firstRestriction; tr != null; tr = tr.next) {
      sb.append(tr.isPositive ? 1 : 0).append(',').append(tr.exceptions).append(',').append(tr.fromLon).append(',')
        .append(tr.fromLat).append(',').append(tr.toLon).append(',').append(tr.toLat).append(';');
    }
    return sb.toString();
  }

  static String linkLine(OsmNode n, OsmLink l, GeometryDecoder gd) {
    OsmNode t = l.getTarget(n);
    boolean rev = l.isReverse(n);
    StringBuilder sb = new StringBuilder("  L ").append(pos(t));
    sb.append(" r=").append(rev ? 1 : 0).append(" b=").append(l.isBidirectional() ? 1 : 0);
    sb.append(" o=").append(l == n ? "S" : l == t ? "T" : "-");
    sb.append(" d=").append(hex(l.descriptionBitmap)).append(" g=").append(hex(l.geometry)).append(" x=");
    if (l.geometry != null) {
      for (OsmTransferNode tn = gd.decodeGeometry(l.geometry, n, t, rev); tn != null; tn = tn.next) {
        sb.append(tn.ilon).append(',').append(tn.ilat).append(',').append(tn.selev).append(';');
      }
    }
    return sb.toString();
  }

  static void dumpGraph(String tag, NodesCache nc, List<OsmNode> seeds) throws Exception {
    GeometryDecoder gd = new GeometryDecoder();
    List<OsmNode> nodes = reachable(nc, seeds);
    int nlinks = 0;
    for (OsmNode n : nodes) {
      line(nodeLine(n));
      for (OsmLink l = n.firstlink; l != null; l = l.getNext(n)) {
        line(linkLine(n, l, gd));
        nlinks++;
      }
    }
    line("G " + tag + " nodes=" + nodes.size() + " links=" + nlinks);
  }

  static void dumpIndex(NodesCache nc) throws Exception {
    List<OsmNode> idx = indexed(nc.nodesMap);
    line("I " + idx.size());
    StringBuilder sb = new StringBuilder("i");
    for (int k = 0; k < idx.size(); k++) {
      sb.append(' ').append(pos(idx.get(k)));
      if (k % 16 == 15 || k == idx.size() - 1) {
        line(sb.toString());
        sb = new StringBuilder("i");
      }
    }
  }

  static final class Holder implements OsmLinkHolder {
    final int id;
    OsmLinkHolder next;

    Holder(int id) {
      this.id = id;
    }

    public void setNextForLink(OsmLinkHolder holder) {
      next = holder;
    }

    public OsmLinkHolder getNextForLink() {
      return next;
    }
  }

  static String holders(OsmLink l, OsmNode source) {
    StringBuilder sb = new StringBuilder("[");
    for (OsmLinkHolder h = l.getFirstLinkHolder(source); h != null; h = h.getNextForLink()) sb.append(((Holder) h).id).append(';');
    return sb.append(']').toString();
  }

  /** What the router does to links: path holders per direction, one-sided unlinks, a start link. */
  static void routerOps(List<OsmNode> nodes) {
    int holder = 0;
    for (int k = 0; k < 8 && !nodes.isEmpty(); k++) {
      OsmNode n = nodes.get(k * nodes.size() / 8);
      OsmLink l = n.firstlink;
      if (l != null && k % 4 == 3 && l.getNext(n) != null) l = l.getNext(n);
      if (l == null) continue;
      OsmNode t = l.getTarget(n);
      for (int h = 0; h < 1 + k % 3; h++) l.addLinkHolder(new Holder(holder++), n);
      boolean bidir = l.isBidirectional(); // else an earlier unlink removed the direction from t
      if (bidir) l.addLinkHolder(new Holder(holder++), t);
      line("holders " + pos(n) + " " + pos(t) + " fwd=" + holders(l, n) + " back=" + (bidir ? holders(l, t) : "-"));
      if (k % 2 == 0) {
        n.unlinkLink(l);
        line("unlinked bidir=" + l.isBidirectional() + " unused=" + l.isLinkUnused() + " back=" + (l.isLinkUnused() ? "-" : holders(l, t)));
      }
    }
    if (!nodes.isEmpty()) {
      OsmLink start = new OsmLink(null, nodes.get(0));
      start.addLinkHolder(new Holder(holder++), null);
      start.addLinkHolder(new Holder(holder), null);
      line("startlink " + pos(start.getTarget(null)) + " " + holders(start, null) + " rev=" + start.isReverse(null) + " bidir=" + start.isBidirectional());
    }
  }

  static List<OsmNode> nonHollow(List<OsmNode> nodes) {
    List<OsmNode> res = new ArrayList<>();
    for (OsmNode n : nodes) if (!n.isHollow()) res.add(n);
    return res;
  }

  // ------------------------------------------------------------------ decode

  static void decode(File segDir, BExpressionContextWay ctx, boolean full, boolean mc, List<int[]> positions) throws Exception {
    NodesCache cache = null;
    int totalNodes = 0;
    int totalLinks = 0;
    for (int i = 0; i < positions.size(); i++) {
      int ilon = positions.get(i)[0];
      int ilat = positions.get(i)[1];
      boolean detailed = i % 4 == 3;
      int cleanupMode = i % 3;
      long maxmem = mc && i % 2 == 1 ? 200000 : MAXMEM;
      if (mc) System.setProperty("disableDirectWeaving", "true");
      else System.clearProperty("disableDirectWeaving");

      NodesCache nc = new NodesCache(segDir, ctx, false, maxmem, cache, detailed);
      cache = nc;
      OsmNodesMap nm = nc.nodesMap;
      nm.cleanupMode = cleanupMode;
      begin(full || i % 20 == 0);
      line("P " + i + " " + ilon + "," + ilat + " mode=" + cleanupMode + " detailed=" + detailed + " mc=" + mc);

      List<OsmNode> seeds = new ArrayList<>();
      if (mc) {
        // pick real nodes from the cell, as MicroCache2 knows them
        MicroCache seg = nc.getSegmentFor(ilon, ilat);
        int size = seg == null ? 0 : seg.getSize();
        line("cell size=" + size);
        int nids = size == 0 ? 0 : i % 5 == 0 ? size : 5;
        long[] ids = new long[nids];
        for (int k = 0; k < ids.length; k++) ids[k] = seg.getIdForIndex(k * size / nids);
        for (long id : ids) {
          OsmNode n = nc.getGraphNode(new OsmNode(id));
          boolean ok = nc.obtainNonHollowNode(n);
          if (nids == 5) {
            line("node " + pos(n) + " ok=" + ok);
            if (ok) nc.expandHollowLinkTargets(n);
          }
          seeds.add(n);
        }
      } else {
        OsmNode start = nc.getGraphNode(new OsmNode(ilon, ilat));
        boolean ok = nc.obtainNonHollowNode(start);
        line("start ok=" + ok + " hollow=" + (start.isHollow() ? 1 : 0));
        seeds.add(start);
        List<OsmNode> hollow = new ArrayList<>();
        for (OsmNode n : indexed(nm)) if (n.isHollow() && n != start) hollow.add(n);
        hollow.sort(DataDump::compareId);
        if (i % 6 == 2 && hollow.size() >= 2) { // end nodes stay indexed when loaded
          nm.endNode1 = hollow.get(0);
          nm.endNode2 = hollow.get(hollow.size() - 1);
          boolean ok1 = nc.obtainNonHollowNode(nm.endNode1);
          boolean ok2 = nc.obtainNonHollowNode(nm.endNode2);
          line("ends " + pos(nm.endNode1) + " " + ok1 + " " + pos(nm.endNode2) + " " + ok2);
        }
        int nexp = i % 2 == 0 ? 3 : 1;
        for (int k = 0; k < nexp && !hollow.isEmpty(); k++) {
          OsmNode h = hollow.get(k * hollow.size() / nexp);
          line("expand " + pos(h) + " ok=" + nc.obtainNonHollowNode(h));
        }
        if (!start.isHollow()) nc.expandHollowLinkTargets(start);
        line("hollowTargets " + nc.hasHollowLinkTargets(start));
      }
      line("elev " + nc.getElevationType(ilon, ilat) + " " + nc.getElevationType(ilon, ilat + 2000000));
      dumpIndex(nc);
      line("created " + nm.nodesCreated);
      dumpGraph("loaded", nc, seeds);
      List<OsmNode> nodes = reachable(nc, seeds);
      totalNodes += nodes.size();
      for (OsmNode n : nodes) for (OsmLink l = n.firstlink; l != null; l = l.getNext(n)) totalLinks++;

      if (i % 5 == 1) {
        routerOps(nonHollow(nodes));
        dumpGraph("unlinked", nc, seeds);
      }

      // memory checks
      nm.destination = new OsmNode(ilon + 20000, ilat + 10000);
      nm.currentMaxCost = 1000 + (i % 5) * 700;
      nm.currentPathCost = 100 * (i % 7);
      line("bounds " + nm.isInMemoryBounds(1000 * (i % 10), false) + " " + nm.isInMemoryBounds(500, true));
      nm.collectOutreachers();
      line("outreach created=" + nm.nodesCreated);
      List<OsmNode> candidates = nonHollow(reachable(nc, seeds));
      List<OsmNode> escapes = new ArrayList<>();
      for (int k = 0; k < 5 && !candidates.isEmpty(); k++) escapes.add(candidates.get(k * candidates.size() / 5));
      for (OsmNode n : candidates) if (n.visitID < nm.baseID && escapes.size() < 10) escapes.add(n); // islands
      for (OsmNode n : escapes) {
        boolean esc = nm.canEscape(n);
        line("escape " + pos(n) + " " + esc + " created=" + nm.nodesCreated);
      }
      nm.clearTemp();
      dumpGraph("collected", nc, seeds);

      // a fresh cache for getStartNode on a real node
      List<OsmNode> real = nonHollow(nodes);
      if (i % 3 == 0 && !real.isEmpty()) {
        OsmNode r = real.get(real.size() / 2);
        NodesCache nc2 = new NodesCache(segDir, ctx, false, maxmem, cache, detailed);
        cache = nc2;
        OsmNode s = nc2.getStartNode(r.getIdFromPos());
        line("startNode " + pos(r) + " " + (s == null ? "null" : nodeLine(s)));
        if (s != null) {
          GeometryDecoder gd = new GeometryDecoder();
          for (OsmLink l = s.firstlink; l != null; l = l.getNext(s)) {
            line(linkLine(s, l, gd));
            line(nodeLine(l.getTarget(s)));
          }
        }
        line("created " + nc2.nodesMap.nodesCreated);
      }
      line("status " + cache.formatStatus());
      end("pos" + i);
    }
    out.println("T positions=" + positions.size() + " nodes=" + totalNodes + " links=" + totalLinks);
  }

  // ------------------------------------------------------------------ waypoint matching

  static String wptLine(String prefix, MatchedWaypoint m) {
    return prefix + " " + m.name + " ty=" + m.wpttype + " wp=" + pos(m.waypoint) + " cp=" + pos(m.crosspoint) + " n1=" + pos(m.node1)
      + " n2=" + pos(m.node2) + " r=" + bits(m.radius) + " dn=" + bits(m.directionToNext) + " dd=" + bits(m.directionDiff)
      + " ix=" + m.indexInTrack;
  }

  static List<MatchedWaypoint> waypoints(int g, int[][] pts) {
    List<MatchedWaypoint> list = new ArrayList<>();
    for (int k = 0; k < pts.length; k++) {
      MatchedWaypoint m = new MatchedWaypoint();
      m.waypoint = new OsmNode(pts[k][0], pts[k][1]);
      m.name = "g" + g + "w" + k;
      if (g % 10 == 4 && k == 0) m.wpttype = MatchedWaypoint.WAYPOINT_TYPE_DIRECT;
      list.add(m);
    }
    return list;
  }

  static NodesCache matchCache;

  static boolean runMatch(String tag, File segDir, BExpressionContextWay ctx, List<MatchedWaypoint> wps, double range, OsmNodePairSet islands) throws Exception {
    matchCache = new NodesCache(segDir, ctx, false, MAXMEM, matchCache, false);
    boolean ok = false;
    try {
      ok = matchCache.matchWaypointsToNodes(wps, range, islands);
      line(tag + " ok=" + ok);
    } catch (IllegalArgumentException e) {
      line(tag + " EXC " + e.getMessage());
    }
    for (MatchedWaypoint m : wps) {
      line(wptLine("W", m));
      for (MatchedWaypoint w : m.wayNearest) line(wptLine("  w", w));
    }
    return ok;
  }

  static void match(File segDir, BExpressionContextWay ctx, boolean full) throws Exception {
    Random rnd = new Random(98765);
    OsmNodePairSet islands = new OsmNodePairSet(1000);
    int total = 0;
    int matched = 0;
    for (int g = 0; total < 520; g++) {
      int n = 1 + rnd.nextInt(3);
      int baseLon = 190000000 + rnd.nextInt(10000000);
      int baseLat = 135000000 + rnd.nextInt(5000000);
      if (g % 25 == 7) baseLon = 190000000 + rnd.nextInt(30000); // western edge of the data
      if (g % 25 == 13) baseLat = 135000000 + rnd.nextInt(30000); // southern edge
      int[][] pts = new int[n][];
      for (int k = 0; k < n; k++) {
        pts[k] = k == 0 ? new int[]{baseLon, baseLat}
          : new int[]{baseLon + rnd.nextInt(100001) - 50000, baseLat + rnd.nextInt(100001) - 50000};
      }
      double range = g % 4 == 3 ? -60000. : 250.;
      begin(full || g % 10 == 0);
      line("M " + g + " n=" + n + " range=" + (int) range);
      List<MatchedWaypoint> wps = waypoints(g, pts);
      boolean ok = runMatch("match", segDir, ctx, wps, range, islands);
      for (MatchedWaypoint m : wps) if (m.crosspoint != null) matched++;
      if (ok && g % 9 == 5 && wps.get(0).node1 != null) {
        islands.addTempPair(wps.get(0).node1.getIdFromPos(), wps.get(0).node2.getIdFromPos());
        islands.freezeTempPairs();
        line("island " + islands.size() + " " + islands.getFreezeCount());
        runMatch("rematch", segDir, ctx, waypoints(g, pts), range, islands);
      }
      end("group" + g);
      total += n;
    }
    // edge cases: outside the data, at its edges, in the sea; each with both ranges
    int[][][] special = {
      {{189500000, 136500000}}, {{190000500, 136500000}}, {{192000000, 135000500}}, {{196000000, 139999500}},
      {{193000000, 135200000}}, {{193000000, 135200000}, {193050000, 135250000}}, {{199999500, 137000000}},
      {{190000500, 136500000}, {190020000, 136510000}}};
    for (int k = 0; k < special.length * 2; k++) {
      int[][] pts = special[k / 2];
      double range = k % 2 == 1 ? -60000. : 250.;
      begin(true);
      line("S " + k + " n=" + pts.length + " range=" + (int) range);
      List<MatchedWaypoint> wps = waypoints(1000 + k, pts);
      runMatch("special", segDir, ctx, wps, range, islands);
      for (MatchedWaypoint m : wps) if (m.crosspoint != null) matched++;
      end("special" + k);
      total += pts.length;
    }
    out.println("T waypoints=" + total + " matched=" + matched);
  }

  // ------------------------------------------------------------------ SortedHeap

  static void heap() {
    Random rnd = new Random(4711);
    SortedHeap<Integer> h = new SortedHeap<>();
    int[] ranges = {3, 10, 100, 1000, 100000, 1 << 30};
    int seq = 0;
    begin(true);
    for (int round = 0; round < 12; round++) {
      if (round % 3 == 0) h.clear();
      int range = ranges[round % 6];
      line("R " + round + " range=" + range);
      for (int op = 0; op < 3000; op++) {
        int r = rnd.nextInt(10);
        if (r < 6) {
          int key = rnd.nextInt(range) - (round % 2 == 1 ? range / 2 : 0);
          h.add(key, seq);
          line("a " + key + " " + seq);
          seq++;
        } else if (r < 9) {
          line("p " + h.popLowestKeyValue());
        } else {
          Object[] t = new Object[1 + rnd.nextInt(8)];
          int n = h.getExtract(t);
          StringBuilder sb = new StringBuilder("e " + n);
          for (int k = 0; k < n; k++) sb.append(' ').append(t[k]);
          line(sb.toString());
        }
      }
      line("size " + h.getSize() + " peak " + h.getPeakSize());
      if (round % 3 == 2) {
        for (Integer v = h.popLowestKeyValue(); v != null; v = h.popLowestKeyValue()) line("p " + v);
      }
    }
    end("heap");
  }

  // ------------------------------------------------------------------ CheapRuler / CheapAngleMeter

  static void ruler() {
    begin(true);
    for (int i = 0; i < 1800; i++) {
      double[] kxky = btools.util.CheapRuler.getLonLatToMeterScales(i * 100000);
      line("s " + i + " " + bits(kxky[0]) + " " + bits(kxky[1]));
    }
    Random rnd = new Random(77);
    btools.util.CheapAngleMeter am = new btools.util.CheapAngleMeter();
    for (int i = 0; i < 20000; i++) {
      int lon0 = 190000000 + rnd.nextInt(10000000), lat0 = 135000000 + rnd.nextInt(5000000);
      int d = i % 2 == 0 ? 2000 : 200000;
      int lon1 = lon0 + rnd.nextInt(2 * d + 1) - d, lat1 = lat0 + rnd.nextInt(2 * d + 1) - d;
      int lon2 = lon1 + rnd.nextInt(2 * d + 1) - d, lat2 = lat1 + rnd.nextInt(2 * d + 1) - d;
      double dist = btools.util.CheapRuler.distance(lon0, lat0, lon1, lat1);
      double dir = btools.util.CheapAngleMeter.getDirection(lon0, lat0, lon1, lat1);
      double diff = btools.util.CheapAngleMeter.getDifferenceFromDirection(dir, btools.util.CheapAngleMeter.getDirection(lon1, lat1, lon2, lat2));
      double angle = am.calcAngle(lon0, lat0, lon1, lat1, lon2, lat2);
      OsmNode a = new OsmNode(lon0, lat0);
      line("r " + bits(dist) + " " + bits(dir) + " " + bits(diff) + " " + bits(angle) + " " + bits(am.getCosAngle()) + " "
        + a.calcDistance(new OsmNode(lon1, lat1)) + " " + bits(btools.util.CheapAngleMeter.normalize(dir - 720 * (i % 3))));
    }
    end("ruler");
  }
}
