package btools.router;

import btools.server.RouteServer;

public final class LocalRulesServer {
  public static void main(String[] args) throws Exception {
    if (LocalRoutingRules.INSTANCE.revision.isEmpty()) throw new IllegalArgumentException("Set -Drichiroute.rules to the prepared rule file");
    System.out.println("Local routing rules: " + LocalRoutingRules.INSTANCE.revision);
    RouteServer.main(args);
  }
}
