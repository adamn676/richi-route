import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import btools.router.FormatJson;
import btools.router.OsmNodeNamed;
import btools.router.OsmTrack;
import btools.router.ProfileCache;
import btools.router.RoutingContext;
import btools.router.RoutingEngine;
import btools.router.RoutingParamCollector;

/**
 * Answers BRouter requests the way RouteServer and ServerHandler do, without a socket.
 * Input: one request per line, "id<TAB>query" with the query string the planner sends to /brouter.
 * Output: one JSON line per request, {"id","ms","error"|"geojson"}, in completion order.
 * Usage: java RouteReference segmentDir profileDir [threads]
 */
public class RouteReference {
  public static void main(String[] args) throws Exception {
    File segmentDir = new File(args[0]);
    System.setProperty("profileBaseDir", args[1]);
    int threads = args.length > 2 ? Integer.parseInt(args[2]) : 1;
    ProfileCache.setSize(2 * threads);
    long maxRunningTime = Long.getLong("maxRunningTime", 60) * 1000;
    PrintStream out = new PrintStream(System.out, false, StandardCharsets.UTF_8);
    ExecutorService pool = Executors.newFixedThreadPool(threads);
    BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
    for (String line; (line = in.readLine()) != null; ) {
      if (line.isEmpty()) continue;
      int tab = line.indexOf('\t');
      String id = line.substring(0, tab);
      String query = line.substring(tab + 1);
      pool.submit(() -> {
        String result = answer(segmentDir, query, maxRunningTime);
        synchronized (out) {
          out.println("{\"id\":" + quote(id) + "," + result + "}");
          out.flush();
        }
      });
    }
    pool.shutdown();
    pool.awaitTermination(1, TimeUnit.DAYS);
  }

  private static String answer(File segmentDir, String query, long maxRunningTime) {
    long start = System.nanoTime();
    try {
      RoutingParamCollector collector = new RoutingParamCollector();
      Map<String, String> params = collector.getUrlParams("/brouter?" + query);
      RoutingContext rc = new RoutingContext();
      rc.memoryclass = 128;
      rc.localFunction = params.get("profile");
      List<OsmNodeNamed> wplist = collector.getWayPointList(params.get("lonlats"));
      params.remove("profile");
      int engineMode = params.containsKey("engineMode") ? Integer.parseInt(params.get("engineMode")) : 0;
      collector.setParams(rc, wplist, params);
      RoutingEngine engine = new RoutingEngine(null, null, segmentDir, wplist, rc, engineMode);
      engine.quite = true;
      engine.doRun(maxRunningTime);
      String ms = "\"ms\":" + (System.nanoTime() - start) / 1_000_000 + ",";
      if (engine.getErrorMessage() != null) return ms + "\"error\":" + quote(engine.getErrorMessage());
      OsmTrack track = engine.getFoundTrack();
      return ms + "\"geojson\":" + quote(new FormatJson(rc).format(track));
    } catch (Throwable e) {
      return "\"ms\":" + (System.nanoTime() - start) / 1_000_000 + ",\"error\":" + quote("exception: " + e);
    }
  }

  private static String quote(String s) {
    StringBuilder sb = new StringBuilder(s.length() + 16).append('"');
    for (int i = 0; i < s.length(); i++) {
      char c = s.charAt(i);
      switch (c) {
        case '"': sb.append("\\\""); break;
        case '\\': sb.append("\\\\"); break;
        case '\n': sb.append("\\n"); break;
        case '\r': sb.append("\\r"); break;
        case '\t': sb.append("\\t"); break;
        default:
          if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
          else sb.append(c);
      }
    }
    return sb.append('"').toString();
  }
}
