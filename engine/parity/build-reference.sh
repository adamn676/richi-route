#!/bin/sh
# Compiles the Java reference: BRouter 1.7.10 as released. The bundle's brouter.jar carries our older
# bicycle-v2 patches in four classes, so their 1.7.10 originals go into classes/pristine, which comes first
# on every reference classpath: pristine:brouter.jar:<tool classes>.
set -eu
engine=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
app="$engine/.."
javac="${RICHIROUTE_JAVA_HOME:-$app/.cache/runtime/java}/bin/javac"
jar="${RICHIROUTE_BROUTER_JAR:-$app/../richiroute-ubuntu-benchmark/brouter.jar}"
src="${RICHIROUTE_BROUTER_SRC:-$app/.cache/brouter-src/brouter-1.7.10}"
out="$engine/target/parity/classes"

rm -rf "$out/pristine" "$out/router"
mkdir -p "$out/pristine" "$out/router"
"$javac" -nowarn -cp "$jar" -d "$out/pristine" \
  "$src/brouter-mapaccess/src/main/java/btools/mapaccess/OsmNode.java" \
  "$src/brouter-core/src/main/java/btools/router/OsmPath.java" \
  "$src/brouter-core/src/main/java/btools/router/StdPath.java" \
  "$src/brouter-expressions/src/main/java/btools/expressions/BExpressionContextWay.java"
"$javac" -cp "$out/pristine:$jar" -d "$out/router" "$engine/parity/java/router/RouteReference.java"
echo "Reference classes in $out"
