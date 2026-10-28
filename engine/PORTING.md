# Porting BRouter to Rust

The engine is a port of BRouter 1.7.10, the version the planner runs today. It has to produce exactly the
same routes. The Java original stays the reference: every layer is checked against it, and any result that
differs is a bug in the port. Speed work comes later and must not change results.

## Source and reference

- Java source: BRouter tag `v1.7.10` (`https://github.com/abrensch/brouter/archive/refs/tags/v1.7.10.tar.gz`),
  unpacked at `../.cache/brouter-src/brouter-1.7.10/` (outside git).
- Reference: BRouter 1.7.10 as released.
  - The bundle's `../../richiroute-ubuntu-benchmark/brouter.jar` carries our older bicycle-v2 patches in
    `OsmNode`, `OsmPath`, `StdPath` and `BExpressionContextWay` (plus `WeidwegPassage`).
  - `parity/build-reference.sh` compiles their 1.7.10 originals into `target/parity/classes/pristine`.
    Every reference classpath is `pristine:brouter.jar:<tool classes>`.
  - Production adds our patches on top (`experiments/routing/brouter-patch/`): the local-rules jar's
    classes ahead of the bundle jar. That comes in a later step, as an explicit layer.
- Java toolchain: `../.cache/runtime/java/bin/{javac,java}`.
- Test data:
  - Routing segments: `../../richiroute-ubuntu-benchmark/data/E10_N45.rd5` and `E15_N45.rd5`.
  - Lookup table and profiles: `../experiments/routing/.local/local-routing-rules/profiles/`
    (`lookups.dat`, `richi-local-v1.brf` — the planner's profile — and two variants).
  - BRouter's standard profiles in the source tree (`misc/profiles2/`) widen the coverage of the profile
    language.

## Crates

One crate per BRouter package, in dependency order: `util`, `codec`, `expressions`, `mapaccess`, then
`router` and a command-line/server binary. `Description` (a shared `Rc<[u8]>` tag bitmap) and the
`ByteArrayUnifier`/`TagValueValidator` traits connect the data layer to the profile language without
either depending on the other.

## Rules for a faithful port

- **Same algorithm, same order.** Keep BRouter's control flow, iteration order and tie-breaking. A
  different but "equivalent" structure is only fine where order provably cannot matter. Comment where the
  Rust structure differs from the Java one.
- **Same number types.** `int` → `i32`, `long` → `i64`, `short` → `i16`, `float` → `f32`,
  `double` → `f64`. Java `byte` is signed: use `i8`, or `u8` with explicit sign extension where Java widens.
- **Java arithmetic.** `int`/`long` overflow wraps in Java, so use `wrapping_*` where it can overflow.
  Shifts by a variable distance use `wrapping_shl`/`wrapping_shr`, which mask the distance like Java.
  `>>>` is a shift on the unsigned type. `>>` on a negative value is arithmetic, as in Rust.
- **Float traps.**
  - `Math.round(x)` is `floor(x + 0.5)`, not Rust's `round`.
  - Float-to-int casts saturate and turn NaN into 0 in both languages.
  - `Math.sqrt` is exact in both. For `sin`, `cos`, `atan2`, `exp`, `log` and `pow`, check results
    bit for bit. If they differ, port the fdlibm routine Java uses.
  - Keep `float` intermediates in `f32`. Widening to `f64` changes results.
- **Maps and sets.** Where Java iterates a `HashMap` and the order affects results, reproduce that order.
  Otherwise use `std` collections.
- **Object graphs become arenas.** Nodes, links and paths live in vectors addressed by `u32` indices,
  not `Rc<RefCell<…>>`. Java `null` becomes `Option`.
- **Errors.** Java exceptions that reach the caller become `Result`s. Keep BRouter's message texts:
  the planner matches on them (`app/src/services/route.service.ts`).
- **Lean.** `std` only: no external crates and no `unsafe` without a measured reason. Leave out code the
  planner never reaches: map creation, diff tools, GPX/KML writers, debug logging and statistics.
- **Phone memory.** Map data is read from the files on demand, as BRouter does. Never load a whole
  segment file.

## Parity checks

Each layer has a Java dump tool and a Rust counterpart that produce the same canonical text. The check
diffs the two outputs, and any difference fails it.
- Java sources live in `parity/java/<layer>/`. They are compiled against the reference jar into
  `target/parity/classes/`.
- Outputs go to `target/parity/`.
- Each layer documents its commands in `parity/README.md`.
- Unit tests that need no local data run under `cargo test`. Checks that need the local segments or
  profiles read their paths from environment variables with the defaults above, and skip with a clear
  message when the data is missing.

## Environment

```sh
export PATH="$PWD/../.cache/runtime/rust/bin:$PATH" CARGO_HOME="$PWD/../.cache/cargo"
cargo test && cargo clippy --all-targets
```

Run from `app/engine/`. Use your own `CARGO_TARGET_DIR` under `target/` when several builds run at once.
