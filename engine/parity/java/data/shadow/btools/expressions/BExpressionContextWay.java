package btools.expressions;

import java.nio.ByteBuffer;
import java.util.HashMap;

import btools.codec.TagValueValidator;
import btools.util.Crc32;
import btools.util.IByteArrayUnifier;

/**
 * Test double for the data-layer parity check (classes/data-shadow, ahead of the reference classes).
 * NodesCache takes the final class BExpressionContextWay, so a deterministic validator can only come in
 * under that name. The Rust counterpart is TestValidator in mapaccess/examples/data_parity.rs; keep both
 * identical. Access types and start ways derive from the description's CRC so that every decoder branch
 * runs without a real profile, and some lookups count as unused to exercise tag filtering.
 */
public final class BExpressionContextWay implements TagValueValidator, IByteArrayUnifier {
  public BExpressionMetaData meta;
  private boolean decodeForbidden = true;
  private final HashMap<ByteBuffer, byte[]> interned = new HashMap<>();

  public BExpressionContextWay(BExpressionMetaData meta) {
    this.meta = meta;
  }

  @Override
  public int accessType(byte[] description) {
    int r = (Crc32.crc(description, 0, description.length) >>> 4) % 10;
    int accessType = r < 2 ? 0 : r < 4 ? 1 : 2;
    return accessType == 1 && !decodeForbidden ? 0 : accessType;
  }

  @Override
  public byte[] unify(byte[] ab, int offset, int len) {
    byte[] copy = new byte[len];
    System.arraycopy(ab, offset, copy, 0, len);
    byte[] known = interned.putIfAbsent(ByteBuffer.wrap(copy), copy);
    return known != null ? known : copy;
  }

  @Override
  public boolean isLookupIdxUsed(int idx) {
    return idx % 5 != 3;
  }

  @Override
  public void setDecodeForbidden(boolean decodeForbidden) {
    this.decodeForbidden = decodeForbidden;
  }

  @Override
  public boolean checkStartWay(byte[] ab) {
    return (Crc32.crc(ab, 0, ab.length) >>> 12) % 8 != 0;
  }
}
