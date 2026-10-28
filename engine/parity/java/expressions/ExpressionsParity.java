import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.FileWriter;
import java.io.IOException;
import java.io.PrintStream;
import java.io.PrintWriter;
import java.lang.reflect.Field;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.TreeMap;

import btools.expressions.BExpressionContext;
import btools.expressions.BExpressionContextNode;
import btools.expressions.BExpressionContextWay;
import btools.expressions.BExpressionMetaData;

/**
 * Parity dumps of the profile language (btools.expressions) against BRouter 1.7.10. The Rust example
 * expressions/examples/parity_dump.rs prints the same text.
 *
 * numbers STRINGS                         Float.parseFloat / Float.toString checks
 * floats                                  Float.toString of every float, hashed per 2^24 bit patterns
 * gen LOOKUPS OUTDIR SEED COUNT PROFILE...  way.txt and node.txt descriptions, encoded by the context
 * dump LOOKUPS PROFILE DESCDIR HASHSIZE [KEY=VALUE...]   parse results and evaluations
 * globals LOOKUPS PROFILE [KEY=VALUE...]                 parse results only
 */
public final class ExpressionsParity {
  private static final PrintStream out = new PrintStream(new BufferedOutputStream(new FileOutputStream(FileDescriptor.out), 1 << 16), false, java.nio.charset.StandardCharsets.UTF_8);

  public static void main(String[] args) throws Exception {
    switch (args[0]) {
      case "numbers":
        numbers(new File(args[1]));
        break;
      case "floats":
        floats();
        break;
      case "gen":
        gen(new File(args[1]), new File(args[2]), Long.parseLong(args[3]), Integer.parseInt(args[4]), Arrays.copyOfRange(args, 5, args.length));
        break;
      case "dump":
        dump(new File(args[1]), new File(args[2]), new File(args[3]), Integer.parseInt(args[4]), Arrays.copyOfRange(args, 5, args.length));
        break;
      case "globals":
        dump(new File(args[1]), new File(args[2]), null, 1, Arrays.copyOfRange(args, 3, args.length));
        break;
      default:
        throw new IllegalArgumentException("unknown command " + args[0]);
    }
    out.flush();
  }

  // ---- numbers ----

  private static int xorshift = 0x9E3779B9;

  private static int next() {
    xorshift ^= xorshift << 13;
    xorshift ^= xorshift >>> 17;
    xorshift ^= xorshift << 5;
    return xorshift;
  }

  /** Non-negative pseudo-random number below n. */
  private static int below(int n) {
    return (next() >>> 1) % n;
  }

  private static void numbers(File strings) throws IOException {
    for (String line : readLines(strings)) {
      String s = unescape(line);
      try {
        out.print("P " + line + " " + hex(Float.parseFloat(s)) + "\n");
      } catch (NumberFormatException e) {
        out.print("P " + line + " ! " + e.getMessage() + "\n");
      }
    }
    for (int k = 1000; k <= 201000; k++) {
      printToString("S", (k - 1000) / 100f);
    }
    for (int j = 0; j < 20000; j++) {
      printToString("S", (j * 107377 + 201000 - 1000) / 100f);
    }
    printToString("S", (Integer.MAX_VALUE - 1000) / 100f);
    for (int i = 0; i < 300000; i++) {
      printToString("R", Float.intBitsToFloat(next()));
    }
    for (int i = 0; i < 200000; i++) {
      String s = randomDecimal();
      try {
        out.print("D " + s + " " + hex(Float.parseFloat(s)) + "\n");
      } catch (NumberFormatException e) {
        out.print("D " + s + " ! " + e.getMessage() + "\n");
      }
    }
  }

  private static void floats() {
    long[] hashes = new long[256];
    java.util.stream.IntStream.range(0, 256).parallel().forEach(block -> {
      long h = 0xcbf29ce484222325L; // FNV-1a over the lines
      for (int low = 0; low < 1 << 24; low++) {
        String s = Float.toString(Float.intBitsToFloat(block << 24 | low)) + "\n";
        for (int i = 0; i < s.length(); i++) {
          h = (h ^ s.charAt(i)) * 0x100000001b3L;
        }
      }
      hashes[block] = h;
    });
    for (int b = 0; b < 256; b++) out.print("F " + b + " " + Long.toHexString(hashes[b]) + "\n");
  }

  private static void printToString(String tag, float v) {
    String s = Float.toString(v);
    out.print(tag + " " + hex(v) + " " + s + " " + hex(Float.parseFloat(s)) + "\n");
  }

  private static String randomDecimal() {
    StringBuilder sb = new StringBuilder();
    if (below(4) == 0) sb.append('-');
    int ndigits = 1 + below(25);
    int point = below(3) == 0 ? -1 : below(ndigits + 1);
    for (int i = 0; i < ndigits; i++) {
      if (i == point) sb.append('.');
      sb.append((char) ('0' + below(10)));
    }
    if (point == ndigits) sb.append('.');
    if (below(2) == 0) {
      sb.append(below(2) == 0 ? 'e' : 'E');
      int sign = below(3);
      if (sign == 1) sb.append('-');
      if (sign == 2) sb.append('+');
      sb.append(below(60));
    }
    return sb.toString();
  }

  private static String unescape(String s) {
    StringBuilder sb = new StringBuilder();
    for (int i = 0; i < s.length(); i++) {
      char c = s.charAt(i);
      if (c != '\\') {
        sb.append(c);
        continue;
      }
      char e = s.charAt(++i);
      switch (e) {
        case 's': sb.append(' '); break;
        case 't': sb.append('\t'); break;
        case 'n': sb.append('\n'); break;
        case 'r': sb.append('\r'); break;
        case 'e': break; // the empty string
        case 'u':
          sb.append((char) Integer.parseInt(s.substring(i + 1, i + 5), 16));
          i += 4;
          break;
        default: sb.append(e);
      }
    }
    return sb.toString();
  }

  // ---- descriptions ----

  private static void gen(File lookups, File outDir, long seed, int count, String[] profiles) throws Exception {
    BExpressionMetaData meta = new BExpressionMetaData();
    BExpressionContextWay way = new BExpressionContextWay(meta);
    BExpressionContextNode node = new BExpressionContextNode(0, meta);
    meta.readMetaData(lookups);

    boolean[] wayUsed = new boolean[lookupNames(way).size()];
    boolean[] nodeUsed = new boolean[lookupNames(node).size()];
    for (String profile : profiles) {
      BExpressionMetaData m = new BExpressionMetaData();
      BExpressionContextWay w = new BExpressionContextWay(m);
      BExpressionContextNode n = new BExpressionContextNode(0, m);
      n.setForeignContext(w);
      try {
        m.readMetaData(lookups);
        w.parseFile(new File(profile), "global");
        n.parseFile(new File(profile), "global");
      } catch (Exception e) {
        continue; // profiles that do not parse with this table weigh nothing
      }
      for (int i = 0; i < wayUsed.length; i++) wayUsed[i] |= w.isLookupIdxUsed(i);
      for (int i = 0; i < nodeUsed.length; i++) nodeUsed[i] |= n.isLookupIdxUsed(i);
    }
    outDir.mkdirs();
    Random rnd = new Random(seed);
    writeDescriptions(way, wayUsed, rnd, count, new File(outDir, "way.txt"));
    writeDescriptions(node, nodeUsed, rnd, count, new File(outDir, "node.txt"));
  }

  /**
   * Every single key=value, then random combinations: highway mostly set, up to 11 more tags picked
   * with weight 8 for keys a profile uses, a few numeric values (1000 and above), and every tenth
   * description a repeat of an earlier one.
   */
  private static void writeDescriptions(BExpressionContext ctx, boolean[] used, Random rnd, int count, File file) throws Exception {
    List<Object[]> keys = lookupValues(ctx);
    List<byte[]> result = new ArrayList<>();
    for (int inum = 1; inum < keys.size(); inum++) {
      for (int v = 1; v < keys.get(inum).length; v++) {
        int[] ld = ctx.createNewLookupData();
        ld[inum] = v;
        result.add(ctx.encode(ld));
      }
    }
    int[] weights = new int[keys.size()];
    int total = 0;
    for (int inum = 1; inum < keys.size(); inum++) {
      weights[inum] = used[inum] ? 8 : 1;
      total += weights[inum];
    }
    int highway = ctx.getLookupNameIdx("highway");
    List<byte[]> random = new ArrayList<>();
    while (random.size() < count) {
      if (random.size() % 10 == 9) {
        random.add(random.get(rnd.nextInt(random.size())).clone());
        continue;
      }
      int[] ld = ctx.createNewLookupData();
      if (highway > 0 && rnd.nextInt(10) > 0) ld[highway] = 1 + rnd.nextInt(keys.get(highway).length - 1);
      int ntags = rnd.nextInt(12);
      for (int t = 0; t < ntags; t++) {
        int pick = rnd.nextInt(total);
        int inum = 1;
        while (pick >= weights[inum]) pick -= weights[inum++];
        ld[inum] = rnd.nextInt(100) < 2 ? 1000 + rnd.nextInt(30000) : 1 + rnd.nextInt(keys.get(inum).length - 1);
      }
      byte[] ab = ctx.encode(ld);
      if (ab != null) random.add(ab);
    }
    result.addAll(random);
    try (PrintWriter pw = new PrintWriter(new FileWriter(file))) {
      for (byte[] ab : result) pw.print(hex(ab) + "\n");
    }
  }

  // ---- dump ----

  private static void dump(File lookups, File profile, File descDir, int hashSize, String[] overrides) throws Exception {
    Map<String, String> keyValues = null;
    if (overrides.length > 0) {
      keyValues = new HashMap<>();
      for (String kv : overrides) {
        int idx = kv.indexOf('=');
        keyValues.put(kv.substring(0, idx), kv.substring(idx + 1));
      }
    }
    out.print("profile " + profile.getName() + "\n");
    out.print("overrides " + String.join(" ", new TreeMap<>(keyValues == null ? new HashMap<>() : keyValues).entrySet().stream().map(e -> e.getKey() + "=" + e.getValue()).toArray(String[]::new)) + "\n");

    // the contexts as ProfileCache sets them up
    BExpressionMetaData meta = new BExpressionMetaData();
    BExpressionContextWay way = new BExpressionContextWay(hashSize, meta);
    BExpressionContextNode node = new BExpressionContextNode(0, meta);
    node.setForeignContext(way);
    try {
      meta.readMetaData(lookups);
      way.parseFile(profile, "global", keyValues);
      node.parseFile(profile, "global", keyValues);
    } catch (Exception e) {
      out.print("error " + e.getMessage() + "\n");
      return;
    }
    out.print("meta " + meta.lookupVersion + " " + meta.lookupMinorVersion + " " + meta.minAppVersion + "\n");
    // RoutingContext.readGlobalConfig and its path model, then ProfileCache
    try {
      if (way._modelClass != null) {
        way.getOutputVariableIndex("maxspeed", false);
        way.getOutputVariableIndex("maxspeed_explicit", false);
        way.getOutputVariableIndex("minspeed", false);
        node.getOutputVariableIndex("maxspeed", false);
      }
    } catch (Exception e) {
      out.print("model error " + e.getMessage() + "\n");
    }
    if (way.getVariableValue("check_start_way", 1f) != 1f) way.freeNoWays();
    if (way.getVariableValue("processUnusedTags", 0f) != 0f) way.setAllTagsUsed();
    printContext("way", way);
    printContext("node", node);
    if (descDir == null) return;

    // a cache-less way context for the full variable sets of each direction
    BExpressionMetaData metaFull = new BExpressionMetaData();
    BExpressionContextWay wayFull = new BExpressionContextWay(0, metaFull);
    metaFull.readMetaData(lookups);
    wayFull.parseFile(profile, "global", keyValues);

    List<byte[]> wayDescs = readDescriptions(new File(descDir, "way.txt"));
    List<byte[]> nodeDescs = readDescriptions(new File(descDir, "node.txt"));

    try {
      evaluations(way, wayFull, node, wayDescs, nodeDescs);
    } catch (RuntimeException e) {
      out.print("evalerror " + e.getMessage() + "\n");
    }
  }

  private static void evaluations(BExpressionContextWay way, BExpressionContextWay wayFull, BExpressionContextNode node,
                                  List<byte[]> wayDescs, List<byte[]> nodeDescs) throws Exception {
    int[] wayVars = contextVariables(wayFull);
    int[] nodeVars = contextVariables(node);
    float[] wayData = (float[]) field(wayFull, "variableData");
    float[] nodeData = (float[]) field(node, "variableData");
    int wayBuildIn = (Integer) field(way, "nBuildInVars");
    int nodeBuildIn = (Integer) field(node, "nBuildInVars");
    StringBuilder sb = new StringBuilder(4096);
    for (int i = 0; i < wayDescs.size(); i++) {
      byte[] ab = wayDescs.get(i);
      for (int r = 0; r < 2; r++) {
        boolean reverse = r == 1;
        sb.setLength(0);
        sb.append("W ").append(i).append(' ').append(r);
        way.evaluate(reverse, ab);
        for (int k = 0; k < wayBuildIn; k++) sb.append(' ').append(hex(way.getBuildInVariable(k)));
        wayFull.evaluate(reverse, ab);
        sb.append(" |");
        for (int idx : wayVars) sb.append(' ').append(hex(wayData[idx]));
        sb.append(" | ").append(way.getKeyValueDescription(reverse, ab)).append('\n');
        out.print(sb);
      }
      out.print("A " + i + " " + way.accessType(ab) + " " + (way.checkStartWay(ab) ? 1 : 0) + " " + unified(way, ab) + unified(way, wayDescs.get(i / 2)) + "\n");
      out.print("D " + i + decoded(wayFull, ab) + "\n");
    }
    for (int j = 0; j < nodeDescs.size(); j++) {
      byte[] ab = nodeDescs.get(j);
      way.evaluate(j % 2 == 1, wayDescs.get(j % wayDescs.size()));
      for (int f = 0; f < 2; f++) {
        boolean flag = f == 1;
        sb.setLength(0);
        sb.append("N ").append(j).append(' ').append(f);
        node.evaluate(flag, ab);
        for (int k = 0; k < nodeBuildIn; k++) sb.append(' ').append(hex(node.getBuildInVariable(k)));
        sb.append(" |");
        for (int idx : nodeVars) sb.append(' ').append(hex(nodeData[idx]));
        sb.append(" | ").append(node.getKeyValueDescription(flag, ab)).append('\n');
        out.print(sb);
      }
      out.print("E " + j + decoded(node, ab) + "\n");
    }
  }

  private static void printContext(String prefix, BExpressionContext ctx) throws Exception {
    List<String> names = lookupNames(ctx);
    List<Object[]> values = lookupValues(ctx);
    StringBuilder sb = new StringBuilder();
    for (int i = 0; i < names.size(); i++) {
      sb.setLength(0);
      sb.append(prefix).append(" lookup ").append(names.get(i));
      Object[] va = values.get(i);
      for (int v = 0; v < va.length; v++) {
        sb.append(v == 0 ? " " : "|").append(va[v]);
        @SuppressWarnings("unchecked")
        List<String> aliases = (List<String>) field(va[v], "aliases");
        if (aliases != null) for (String alias : aliases) sb.append('/').append(alias);
      }
      out.print(sb.append('\n'));
    }
    Map<String, Integer> numbers = variableNumbers(ctx);
    int minWriteIdx = (Integer) field(ctx, "minWriteIdx");
    out.print(prefix + " nodes " + field(ctx, "expressionNodeCount") + " exprs " + ((List<?>) field(ctx, "expressionList")).size()
      + " vars " + numbers.size() + " readonly " + minWriteIdx + "\n");
    out.print(prefix + " model " + ctx._modelClass + "\n");
    int[] buildIn = (int[]) field(ctx, "buildInVariableIdx");
    int nBuildIn = (Integer) field(ctx, "nBuildInVars");
    sb.setLength(0);
    sb.append(prefix).append(" buildin");
    for (int i = 0; i < nBuildIn; i++) sb.append(' ').append(buildIn[i] >= 0 ? 1 : 0);
    out.print(sb.append('\n'));
    sb.setLength(0);
    sb.append(prefix).append(" used");
    for (int i = 0; i < names.size(); i++) if (ctx.isLookupIdxUsed(i)) sb.append(' ').append(names.get(i));
    out.print(sb.append('\n'));
    sb.setLength(0);
    sb.append(prefix).append(" nostart");
    for (int i = 0; i < ctx.noStartWays.length; i += 2) sb.append(' ').append(names.get(ctx.noStartWays[i])).append(':').append(ctx.noStartWays[i + 1]);
    out.print(sb.append('\n'));
    float[] data = (float[]) field(ctx, "variableData");
    for (Map.Entry<String, Integer> e : new TreeMap<>(numbers).entrySet()) {
      out.print(prefix + " var " + e.getKey() + " " + hex(data[e.getValue()]) + (e.getValue() < minWriteIdx ? " r" : "") + "\n");
    }
  }

  /** Variable indices of the context's own (not read-only) variables, sorted by name. */
  private static int[] contextVariables(BExpressionContext ctx) throws Exception {
    int minWriteIdx = (Integer) field(ctx, "minWriteIdx");
    return new TreeMap<>(variableNumbers(ctx)).values().stream().filter(idx -> idx >= minWriteIdx).mapToInt(Integer::intValue).toArray();
  }

  /** 1 if two unify calls on copies return the same (cached) array, the second at an offset. */
  private static int unified(BExpressionContext ctx, byte[] ab) {
    byte[] padded = new byte[ab.length + 3];
    System.arraycopy(ab, 0, padded, 3, ab.length);
    byte[] u1 = ctx.unify(ab.clone(), 0, ab.length);
    byte[] u2 = ctx.unify(padded, 3, ab.length);
    if (!Arrays.equals(u1, ab) || !Arrays.equals(u2, ab)) throw new IllegalStateException("unify changed the bytes");
    return u1 == u2 ? 1 : 0;
  }

  /** The decoded lookup values and the numbers v: reads from them. */
  private static String decoded(BExpressionContext ctx, byte[] ab) {
    int[] ld = ctx.createNewLookupData();
    ctx.decode(ld, false, ab);
    ctx.decode(ab);
    StringBuilder sb = new StringBuilder();
    for (int i = 0; i < ld.length; i++) {
      if (ld[i] != 0) sb.append(' ').append(i).append(':').append(ld[i]).append('=').append(hex(ctx.getLookupValue(i)));
    }
    return sb.toString();
  }

  // ---- helpers ----

  @SuppressWarnings("unchecked")
  private static List<Object[]> lookupValues(BExpressionContext ctx) throws Exception {
    return (List<Object[]>) field(ctx, "lookupValues");
  }

  @SuppressWarnings("unchecked")
  private static List<String> lookupNames(BExpressionContext ctx) throws Exception {
    return (List<String>) field(ctx, "lookupNames");
  }

  @SuppressWarnings("unchecked")
  private static Map<String, Integer> variableNumbers(BExpressionContext ctx) throws Exception {
    return (Map<String, Integer>) field(ctx, "variableNumbers");
  }

  private static Object field(Object o, String name) throws Exception {
    for (Class<?> c = o.getClass(); c != null; c = c.getSuperclass()) {
      try {
        Field f = c.getDeclaredField(name);
        f.setAccessible(true);
        return f.get(o);
      } catch (NoSuchFieldException e) {
        // look in the superclass
      }
    }
    throw new NoSuchFieldException(name);
  }

  private static List<String> readLines(File file) throws IOException {
    return Files.readAllLines(file.toPath());
  }

  private static List<byte[]> readDescriptions(File file) throws IOException {
    return readLines(file).stream().map(HexFormat.of()::parseHex).toList();
  }

  private static final char[] HEX = "0123456789abcdef".toCharArray();

  private static String hex(float v) {
    int bits = Float.floatToRawIntBits(v);
    char[] c = new char[8];
    for (int i = 7; i >= 0; i--) {
      c[i] = HEX[bits & 15];
      bits >>>= 4;
    }
    return new String(c);
  }

  private static String hex(byte[] ab) {
    return HexFormat.of().formatHex(ab);
  }
}
