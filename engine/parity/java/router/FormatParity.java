import java.text.DecimalFormat;
import java.text.NumberFormat;
import java.util.Locale;
import java.util.Random;

/**
 * Prints the number formats the router's output uses, for comparison with router/examples/format_parity.rs:
 * Double.toString (StringBuilder.append(double)), DecimalFormat("0.###") on floats (FormatJson "times"),
 * and Formatter.formatILon/formatILat. Floats from 2^63 up are
 * left out: there DecimalFormat takes FloatingDecimal's general digit generation, which the port does not have
 * (no time value comes near).
 * Usage: java FormatParity [count]
 */
public class FormatParity {
  public static void main(String[] args) throws Exception {
    int count = args.length > 0 ? Integer.parseInt(args[0]) : 1_000_000;
    StringBuilder sb = new StringBuilder(1 << 20);
    java.io.PrintStream out = new java.io.PrintStream(new java.io.FileOutputStream(java.io.FileDescriptor.out), false, "UTF-8");
    Random rnd = new Random(20261027);
    DecimalFormat df = (DecimalFormat) NumberFormat.getInstance(Locale.ENGLISH);
    df.applyPattern("0.###");
    java.lang.reflect.Method ilon = btools.router.Formatter.class.getDeclaredMethod("formatILon", int.class);
    java.lang.reflect.Method ilat = btools.router.Formatter.class.getDeclaredMethod("formatILat", int.class);
    ilon.setAccessible(true);
    ilat.setAccessible(true);

    // every elevation the output can carry: selev / 4.
    for (int s = Short.MIN_VALUE; s <= Short.MAX_VALUE; s++) sb.append("E ").append(s).append(' ').append(s / 4.).append('\n');
    flush(out, sb);
    // doubles: random bit patterns, values around the plain/scientific limits, subnormals
    double[] special = {0.0, -0.0, 1e-3, 9.999999999999998E-4, 1e7, 9999999.999999998, 1e23, 2e23, 4.9e-324, 1e-323, 2.2250738585072014E-308,
      Double.MAX_VALUE, Double.MIN_NORMAL, Double.NaN, Double.POSITIVE_INFINITY, Double.NEGATIVE_INFINITY, 0.1, 0.2, 0.30000000000000004, 123456.789, 5e-324 * 3};
    for (double d : special) appendDouble(sb, d);
    for (int i = 0; i < count; i++) {
      appendDouble(sb, Double.longBitsToDouble(rnd.nextLong()));
      appendDouble(sb, (rnd.nextDouble() - 0.5) * Math.pow(10, rnd.nextInt(30) - 12));
      appendDouble(sb, Double.longBitsToDouble(rnd.nextLong() & 0x000fffffffffffffL)); // subnormal
      if (sb.length() > 1 << 20) flush(out, sb);
    }
    // DecimalFormat("0.###") on floats: times in seconds, ties at k/16, negatives, random bits
    for (int i = 0; i < count; i++) {
      float t = rnd.nextFloat() * (float) Math.pow(10, rnd.nextInt(8) - 2);
      float tie = (rnd.nextInt(1 << 20) * 2 + 1) / 16f;
      float neg = -rnd.nextFloat() * 0.01f;
      float bits = Float.intBitsToFloat(rnd.nextInt());
      for (float f : new float[] {t, tie, neg, bits}) {
        if (Math.abs(f) >= 0x1p63f) continue;
        sb.append("T ").append(Integer.toHexString(Float.floatToRawIntBits(f))).append(' ').append(df.format(f)).append('\n');
      }
      if (sb.length() > 1 << 20) flush(out, sb);
    }
    // coordinates
    for (int i = 0; i < count / 10; i++) {
      int lon = rnd.nextInt(360_000_001), lat = rnd.nextInt(180_000_001);
      sb.append("P ").append(lon).append(' ').append(lat).append(' ').append(ilon.invoke(null, lon)).append(' ').append(ilat.invoke(null, lat)).append('\n');
    }
    flush(out, sb);
    out.flush();
  }

  private static void appendDouble(StringBuilder sb, double d) {
    sb.append("D ").append(Long.toHexString(Double.doubleToRawLongBits(d))).append(' ').append(d).append('\n');
  }

  private static void flush(java.io.PrintStream out, StringBuilder sb) {
    out.print(sb);
    sb.setLength(0);
  }
}
