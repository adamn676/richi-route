package btools.util;
import java.util.Random;
public class LruParity {
  static class Node extends LruMapNode {
    final int id;
    Node(int id) { this.id = id; hash = id * 1103515245; }
    public int hashCode() { return hash; }
    public boolean equals(Object other) { return other instanceof Node && id == ((Node) other).id; }
  }
  static void equal(LruMapNode a, LruMapNode b) {
    if (a == null ? b != null : b == null || ((Node) a).id != ((Node) b).id) throw new AssertionError("Cache order or lookup differs");
  }
  public static void main(String[] args) {
    Random random = new Random(84413);
    int operations = 0;
    for (int size : new int[] {2, 3, 8, 127, 1024, 4096}) {
      for (int bins : new int[] {size, size * 4, 4096}) {
        LruMap actual = new LruMap(bins, size);
        ReferenceLruMap reference = new ReferenceLruMap(bins, size);
        for (int i = 0; i < 100000; i++) {
          int id = random.nextInt(size * 2);
          Node key = new Node(id);
          LruMapNode a = actual.get(key), b = reference.get(key);
          equal(a, b);
          if (a != null) { actual.touch(a); reference.touch(b); }
          else {
            equal(actual.removeLru(), reference.removeLru());
            actual.put(new Node(id)); reference.put(new Node(id));
          }
          operations++;
        }
      }
    }
    System.out.println("Identical cache lookups and eviction order across " + operations + " operations.");
  }
}
