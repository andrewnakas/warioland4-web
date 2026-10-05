# Wario Land 4

**Both candidate repositories build a byte-identical ROM.** The browser target runs
that build on a WebAssembly build of mGBA, from a ROM the user picks themselves.

The headline number needs a caveat that the number itself does not carry, so it is
stated up front:

> **"The artifacts match" and "the game is decompiled" are different claims here.**
> The build is byte-identical to the staged cartridge dump. But **34.4% of the 8 MB
> ROM image is copied verbatim out of the user's own ROM at build time**, and most of
> the remaining 65.6% is large committed *data* tables rather than decompiled logic.
> The 99.32% figure is a real, reproducible measurement of **code**, over a 603 KB
> scope that is 7.2% of the ROM. Section 2 has the numbers and how I got them.

---

## 1. Which repository, and why

The census pointed at two repos with apparently contradictory signals. Both turned
out to build and match, so the choice was made on substance rather than on which one
works.

| | `lilDavid/warioland4` (upstream) | `TsilaAllaoui/warioland4` (fork) |
|---|---|---|
| builds | yes | yes |
| ROM byte-identical | **yes** | **yes** |
| code matched (same tool, my run) | **12.33%** (74,746 / 606,250 B) | **99.32%** (598,964 / 603,064 B) |
| functions matched | 478 / 4,017 | 3,990 / 3,992 |
| ROM built from committed source | 12.96% | **65.63%** |
| ROM copied from the user's dump | 87.04% | **34.37%** |
| last pushed | 2026-07-17 | 2026-09-30 |
| README self-description | "work-in-progress" | **also "work-in-progress"** |
| build time, `-j12` | 5 s | 17 s |

**Chosen: the fork, `TsilaAllaoui/warioland4`.** Three reasons:

1. Both match, so matching is not a discriminator. The fork represents **five times
   more of the ROM in committed source** (65.6% vs 13.0%) and eight times more of the
   code (99.3% vs 12.3%). If the point of using a decompilation rather than the raw
   ROM is that the source describes the game, the fork describes far more of it.
2. **The fork is where the work is.** Upstream's own HEAD, `abb7800`, is
   *"Merge pull request #2 from TsilaAllaoui/..."* — upstream is merging the fork's
   work, not the other way round. Upstream has not been pushed since July; the fork
   was pushed five days before this session.
3. The fork's `tools/gen_decomp_progress.py` and `include/wario.h` give the browser
   test real symbol names and struct offsets to gate gameplay on. Against upstream,
   most of that state is still unnamed assembly.

The cost of choosing the fork is that it is one person's fork rather than the
canonical project, and its `master` is not a release. That is handled by pinning an
exact commit (below) rather than tracking a branch.

### Resolving the census's two confusing signals

**"data at 0%" is not a measurement.** It is a literal constant. In
`tools/gen_decomp_progress.py`, which is what produces the `report.json` decomp.dev
consumes, `total_data` and `complete_data` are written as `0` (lines 1967, 1971,
1999, 2003) and `complete_data_percent` as `0.0` (lines 2010, 2045); `sections` is
always `[]`. `tools/progress_config.json` additionally excludes `asm/data/**` and
`asm/blob_*.s` from scope. So the project reports **no data denominator at all**, and
decomp.dev renders 0/0 as 0%. Data is *unmeasured*, not *untouched* — the fork has in
fact moved several megabytes of sprite data into committed C.

**The "upstream says WIP" tension does not exist.** The fork's README says
"work-in-progress" too; it is a copy of upstream's with a progress treemap inserted.
Neither project claims to be finished, and the fork is right not to.

**The 99.32% is real.** I did not take it from decomp.dev. I ran the fork's own
progress tool against the tree I built and got
`matched_code_percent = 99.32013849276362` — 598,964 of 603,064 bytes, 3,990 of 3,992
functions, 170 of 172 units. Running the *same* tool against upstream gives 12.33%.

### Pinned revisions

```
TsilaAllaoui/warioland4   bfbbb8f4346144bee7a1a218dbe889a199e26f63   (2026-09-30)
                          "Matched RenderVortexCutsceneOam"          [chosen]
lilDavid/warioland4       abb7800a8d8fa6d7f7f003627893e06bc2879329   (2026-07-17)
                          "Merge pull request #2 from TsilaAllaoui/Match_disasm_transparency"
```

Checked out detached at those commits, not tracking a branch.

---

## 2. The matching build

### Hashes

The repo documents **md5 only**, in `warioland4_us.md5`. I checked it against the
staged ROM *before* building anything; they agree, so there was no mismatch to report.

| | md5 | sha1 | size |
|---|---|---|---|
| staged `roms/warioland4.gba` | `5fe47355a33e3fabec2a1607af88a404` | `b9fe05a8080e124b67bce6a623234ee3b518a2c1` | 8388608 |
| repo's `warioland4_us.md5` | `5fe47355a33e3fabec2a1607af88a404` | — (not documented) | — |
| **built, fork @ bfbbb8f** | **`5fe47355a33e3fabec2a1607af88a404`** | **`b9fe05a8080e124b67bce6a623234ee3b518a2c1`** | 8388608 |
| **built, upstream @ abb7800** | **`5fe47355a33e3fabec2a1607af88a404`** | **`b9fe05a8080e124b67bce6a623234ee3b518a2c1`** | 8388608 |

Verified two ways, not one: the build's own `md5sum -c` (the default `make` target is
`check`, which fails the build on a mismatch), and an independent `cmp` of the built
file against the staged ROM afterwards. Both clean, for both repositories. The fork's
build was then **reproduced from a wiped `build/`, `data/` and `include/data/`** at
the pinned commit, same hashes.

ROM header: title `WARIOLANDE`, game code `AWAE`, maker `01`, revision byte `0x00`.
Save-type signature string in the image: `SRAM_V112`.

### How much of that ROM is actually built from source

This is the number that matters for reading the match honestly, and the arithmetic
you would reach for first gives the wrong answer.

Summing the `baserom_blob start, end` directives in `asm/` suggests the fork copies
6,762,316 bytes (80.6%) from the cartridge. **That overcounts**, because several
`asm/blob_*.s` files are leftovers: they are still assembled (the Makefile globs
`asm/**/*.s`) but are no longer referenced by `linker.ld`, having been superseded by
`src/data/sprite_data_*.c`. Four of the ten blob files in the fork are dead that way.

So I measured it directly instead, by differential:

1. Generate two 8 MB pseudorandom "baseroms" with different generators.
2. For each: point `baserom_us.gba` at it, re-run `tools/extract_assets.py` (the
   extractor reads the baserom too, so this captures extracted assets as well as
   `.incbin`), wipe `build/`, rebuild.
3. Any output byte that differs from the real build came from the baserom. Take the
   **union** across both poisons, so a byte that coincidentally matched one poison is
   still counted.

| | ROM-derived (from the user's dump) | built from committed source |
|---|---|---|
| **fork @ bfbbb8f** | **2,883,015 B — 34.37%** | **5,505,593 B — 65.63%** |
| upstream @ abb7800 | 7,301,401 B — 87.04% | 1,087,207 B — 12.96% |

The source-built regions in the fork are eight contiguous runs, the largest being
`0x40F1C8–0x78EBF0` (3.67 MB) and `0x000000–0x0956E4` (612 KB).

**What that 65.63% mostly is:** committed data, not decompiled logic.
`src/data/sprite_data_41000C_6D3394.c` alone is an 18 MB C file of literal arrays;
`src/data/` is 28 MB of C across 14 files. The fork's own in-scope **code** figure —
the 99.32% — covers 603,064 bytes, which is **7.2% of the ROM image**. So:

- the build matches: **verified, twice, for both repos**;
- the *code* is almost entirely decompiled and matching: **verified, 99.32%**;
- the ROM *as shipped bytes* is roughly a third verbatim cartridge data, a third-plus
  machine-transcribed data tables, and a small fraction compiled C.

A green build here proves the pipeline. It does not prove the game has been
understood, and this file should not be read as claiming it does.

### Toolchain

| component | version | where from |
|---|---|---|
| agbcc | `pret/agbcc` @ `da598c1d918402c42c0c0d7128ba14567f3175e9` | shared `~/decompfleet/shared/agbcc-install`, prebuilt by the pokefirered agent |
| arm-none-eabi binutils | 2.45.50.20251209 | Ubuntu `binutils-arm-none-eabi` deb, `~/decompfleet/shared/arm-bin` |
| host gcc | 15.2.0 (Ubuntu 26.04) | system — builds `tools/gbafix` |
| host cc as C preprocessor | gcc 15.2.0 `-E` | the Makefile's own `CPP = $(HOSTCC) -E` |
| python | 3.14.4, pyyaml 6.0.3 | system |
| emscripten | 4.0.10 (`b7dc6e57`) | shared emsdk |
| mGBA | `68cf79fe55257b61efaeea87c83de69aab01f963` | shared wasm build, see §3 |

**The agbcc submodule pins differ between the two repos and it does not matter.**
The fork pins `da598c1d`, upstream pins `84d56fc8`. `da598c1d` is exactly one commit
ahead of `84d56fc8` and that commit touches **only `build.sh`** (+2/−2, "Avoid
multithreaded make where that doesn't work"). Codegen is identical, and the shared
prebuilt — which was built from `da598c1d` — matches the chosen repo's pin exactly.

### Reproducing it

`make tools` is **not** what I ran. It builds agbcc from source and creates a venv to
`pip install pyyaml`; both are unnecessary here and the venv needs network. The
equivalent, using what is already on the box:

```sh
export PATH="$HOME/decompfleet/shared/arm-bin/usr/bin:$PATH"

git clone https://github.com/TsilaAllaoui/warioland4
cd warioland4 && git checkout --detach bfbbb8f4346144bee7a1a218dbe889a199e26f63

# agbcc, prebuilt. The Makefile wants the binaries and libs at the agbcc dir root
# (that is where build.sh leaves them), NOT in bin/ and lib/.
mkdir -p tools/agbcc
cp ~/decompfleet/shared/agbcc-install/bin/{agbcc,old_agbcc,agbcc_arm} tools/agbcc/
cp ~/decompfleet/shared/agbcc-install/lib/{libgcc.a,libc.a}           tools/agbcc/
cp -r ~/decompfleet/shared/agbcc-install/include                      tools/agbcc/include

cc tools/gbafix/gbafix.c -o tools/gbafix/gbafix     # host tool, no flags needed
ln -s /path/to/your/warioland4.gba baserom_us.gba   # your own dump
python3 tools/extract_assets.py -v us -q            # system pyyaml; no venv needed
make -j$(nproc)                                     # default target runs md5sum -c
```

Notes for anyone repeating this, since **this is not a pret repo** and several pret
habits do not transfer:

- `TOOLCHAIN` here is a **command prefix** (`arm-none-eabi-`), not a directory. Do not
  pass `.../usr` the way pret's Makefiles want.
- `CPP = $(HOSTCC) -E`, so **`arm-none-eabi-cpp` is not needed** — unlike pokeruby and
  pokefirered, where a binutils-only prefix cannot produce a matching build.
- There is no `compare_*` target. The **default** target is `check`, which runs
  `md5sum -c` already, so a clean `make` exit already means "matched".
- `CPPFLAGS` is `-nostdinc -I include`, so agbcc's own headers are never on the
  include path; `libc.a` is still linked.
- `clang-format` is listed as a dependency but is only needed for formatting, not for
  building. It is absent on this box and nothing failed.
- Only 240 KB comes out of `tools/extract_assets.py`. Nearly all cartridge data
  arrives through `.incbin "baserom_us.gba"` in the `asm/blob_*.s` files instead.
- The fork's default `make` also regenerates `docs/progress-*.svg|html` and can touch
  `README.md`. Expect a dirty working tree after a build; it is not a build failure.
- **`make` does not notice that you swapped `baserom_us.gba`.** The blob objects
  depend on it only through `.incbin`, which `make` cannot see, and a cartridge dump's
  mtime is typically older than your object files anyway — the staged ROM here is
  dated 1996. So changing ROMs, or switching between US and JP, silently links the
  *previous* ROM's data and produces a wrong image with no warning. Always
  `rm -rf build data include/data` and re-extract when the baserom changes. This bit
  me during the differential in §2 and left a stale artifact behind; both trees were
  rebuilt from scratch and re-verified afterwards.

A full clean build of the fork is ~17 s wall / ~31 s CPU at `-j12`.

---

## 3. The browser target

**Shipped: the matching ROM on a direct WebAssembly build of mGBA's `mCore` API.**
Not EmulatorJS, and not a native wasm port of the decompilation.

The stack is the `pokeruby` agent's, reused deliberately: a 427-line C shim over
`mCore` plus one static page, with no emulator frontend in between, which sidesteps
every EmulatorJS trap recorded in `shared/emulatorjs-notes.md` (the CDN version ping,
the `EJS_gameName` save-naming trap, the inline-style wipe, and trap 10's
`beforeunload`→`exit`→`FS.unmount` save destruction) by not having any of that code.

```
dist/warioland4.wasm   664 KB
dist/warioland4.js      19 KB
dist/index.html        3.1 KB
dist/app.js             19 KB
dist/app.css           3.1 KB
```

`libmgba.a` is **linked from `~/decompfleet/games/pokeruby/ref/mgba/build-wasm/`**,
which that agent explicitly offered for reuse (the core is GBA-generic and rebuilding
it costs ~1.5 G of disk for an identical artifact). Disk was at 8–12 G free all
session with 18 agents running, so that mattered. If that tree disappears, rebuild
with the `emcmake` line in `shared/agbcc-notes.md` under "Browser target: mGBA to
wasm directly" — it is reproduced verbatim there and is what produced this `.a`.

### What differs from the pokeruby stack

- **`SAVE_BYTES` is 32 KiB, not 128 KiB.** Wario Land 4's header declares `SRAM_V112`
  — battery-backed SRAM, not FLASH1M. mGBA picks its save media from the buffer size
  it is handed, so this is exact rather than generous.
- **`vj_read8/16/32` expose the emulated bus**, so the tests can read the game's own
  IWRAM. There is deliberately **no write counterpart**: a test must not be able to
  manufacture the state it claims to observe.
- **`vj_game_code()` is separate from `vj_game_title()`.** pokeruby returns title and
  code as one 16-byte blob; that works for "POKEMON RUBY" (exactly 12 chars) but
  `WARIOLANDE` is 10, so the NUL padding truncates the string at the title and the
  code is unreachable from JS. This cost one red test before I spotted it.
- **The page's script and stylesheet are separate files**, purely so the CSP can be
  strict (below).

### The user supplies the ROM, and the CSP is the boundary

A real `<input type=file>` plus drag-and-drop, read with the File API straight into
wasm linear memory. The page is static files with no server component.

The "never uploaded" guarantee is **a Content-Security-Policy, not page script**:

```
default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self';
img-src 'self' blob: data:; connect-src 'self';
form-action 'none'; base-uri 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'
```

`connect-src 'self'` means no script on the page can reach another origin even if it
tries. That is enforced by the browser, wins no races, needs no monkey-patched
`fetch`, and a reviewer can check it by reading one line. There is no `'unsafe-inline'`
anywhere — hence the separate `app.js` / `app.css`.

**The test proves it is the CSP doing the blocking**, which matters more than it
sounds: on a box with no outbound network a cross-origin fetch rejects anyway, so
"the fetch failed" would pass against a page with no CSP at all. The harness therefore
requires (a) a `securitypolicyviolation` event naming `connect-src`, and (b) a
same-origin fetch to still succeed. Observed:
`connect-src blocked https://cdn.emulatorjs.org/stable/data/version.json`, and
`app.css` → `OK 200`.

The ROM is cached in IndexedDB so a reload does not re-prompt, with a "forget ROM"
button. It never leaves the device.

---

## 4. What I actually tested

All testing was **muted**: the page constructs no `AudioContext` at all unless the
unmute button is clicked, the harness never clicks it and asserts none exists, and
Chrome additionally ran with `--mute-audio`.

### Gating "played" on the game's own state

Wario Land 4 has an attract demo, and **I verified that it is a trap for this title
rather than assuming so**. With zero input from boot, at frame 8640 (144.7 s) the game
enters `GM_DEMO` and drives Wario from x=362 to x=1582 at mean luma 121. A bright,
animated, Wario-is-running screenshot is therefore **not** evidence of gameplay here.

So "played" is gated on the game's own variables, at addresses resolved at test time
from `build/us/warioland4_us.map` — the map emitted by the build under test — and
struct offsets parsed out of the repo's `include/wario.h`, with the test failing if
the two disagree. Nothing is hardcoded from a wiki.

```
gMainGameMode        0x03000c3a   (s16, enum GameMode, include/main.h:19)
gWarioData           0x03001898   (struct WarioData, include/wario.h:254)
  +0x12 xPosition  +0x14 yPosition  +0x16 xVelocity
gCurrentPassage      0x03000002
gCurrentStageNumber  0x03000003
gCurrentStageID      0x03000004
```

The bar was verified movement in the first level, and that is where I stopped.

### Core, in node — 30/30, muted

`make selftest`. Both the ROM identity and the gameplay gate:

- header `WARIOLANDE` / `AWAE` / revision 0; save type `SRAM_V112`; save buffer 32 KiB
- **attract-demo control**: idling with no input reaches `GM_DEMO`, moves Wario 1,220
  units, luma 121 — and `gMainGameMode` still says 8, not 2
- menus to `GM_FILE_SELECT` → `GM_STAGE_SELECT` → `GM_GAME_SCREEN`, in
  passage 0 / stage 0 (Entry Passage, Hall of Hieroglyphs)
- holding RIGHT moves Wario x 2016 → 2337; pressing A lifts him y 1279 → 1083;
  releasing input stops him
- picture not black (luma 112) and the frame hash keeps changing
- the game has written its own SRAM (249 non-zero bytes); a core restored with those
  bytes reports the same save hash
- savestate round trip: snapshot → 240 frames of divergence → restore → replaying one
  frame reproduces the exact frame hash. The test fails itself as vacuous if the
  picture did not change during the divergence window.

**I looked at the frames**, not only at the luma numbers. Dumped PPMs show the intro
cutscene, the `NO DATA` file-select screen, the pyramid entrance, and Hall of
Hieroglyphs with the heart meter, the score counter, the frog switch and Wario on the
ledge — then Wario in a visibly different position after the run and the jump.

### The real page, headless Chrome — 43/43, muted, three consecutive runs

`make browsercheck`. The ROM is fed to the genuine file input over
`DOM.setFileInputFiles`, so the picker, File API path, IndexedDB cache and boot
sequence under test are the ones a user gets.

- wasm core initialises; ROM accepted through the real picker; `AWAE`; `SRAM_V112`
- **CSP enforced** (violation event + same-origin control, above)
- **canvas has non-zero CSS size** (952×552) and a 240×160 backing store — asserted
  explicitly, because a core can render at 60 fps into a 0×0 canvas while reporting a
  climbing frame counter
- the full gameplay gate above, re-run in the browser: `GM_GAME_SCREEN`, not
  `GM_DEMO`, passage 0 stage 0, x 2016 → 2337, jump y 1279 → 1125
- **the screenshot is measured outside the page** — `Page.captureScreenshot` decoded
  by `tools/canvas_luma.py` and cropped to the canvas rect: mean luma 100.2, 79.1% of
  pixels lit. The page is never asked to measure its own canvas.
- **no AudioContext object exists**; page reports audio off
- **no request to any other origin at the CDP network layer**; the ROM was never
  fetched over the network
- cartridge save across a **real page reload** (next section)
- ROM resumes from local cache without the picker
- no uncaught page errors, no console errors

Screenshot of the shipping page, taken by the harness, shows the game at full size
with the status line `WARIOLANDE · AWAE · SRAM_V112` and the control bar below.

### Saves — proven, with a detector that was itself validated

Wario Land 4 has a real battery save, so this is genuine data loss if it is wrong.

Two things are asserted, in order of strength:

1. **The save image the game itself wrote during play round-trips byte-for-byte**
   into IndexedDB (30 of the first 32 bytes non-zero, head `[175,19,158,209,...]`).
   These are Wario Land 4's own SRAM routines' output, not a pattern I invented.
2. A chosen marker written through the explicit save path also round-trips, survives
   the lifecycle events, and survives a real same-tab reload — read back from
   IndexedDB **before the ROM boots on the second load**, so no running core can have
   rewritten it.

The mechanism test (`make savecheck`) follows the method in
`pokefirered/tools/save_mechanism.py`: **dispatch `pagehide`/`visibilitychange`
rather than navigating away.** A navigate-away soak is a weak detector — it passed
8/8 on a provably broken page elsewhere on this fleet — because the tab usually dies
before a destructive teardown's writes land.

**And the detector was validated against a known-bad arm.** A comparison where the
two arms might silently be the same page proves nothing, so the harness injects a
deliberately destructive `pagehide` listener of exactly the shape that breaks the
EmulatorJS pages, and the test fails unless that arm is reported as destroyed:

| arm | store after dispatch | verdict |
|---|---|---|
| the shipped page | 32768 bytes, marker intact | **INTACT** |
| injected destructive listener (control) | **0 bytes** | **DESTROYED (store emptied)** |

Five consecutive runs, 6/6 each, both arms stable. The broken arm's signature —
an emptied store — is the same fingerprint trap 10 describes. The broken code lives
in the test, never in the shipped page.

**One real flake, found and fixed, worth recording.** The first version of this test
was intermittently red on the *good* arm (3 of 5 runs). The cause was in the
measurement, not the page: **Wario Land 4 rewrites its SRAM image continuously while
it runs**, so a marker written into a live core was overwritten by the game within
about a second, and the test then reported a lost save that was never lost. The fix is
a test-only `__vj.setPaused()` that freezes the core before the save is measured, with
the harness asserting the freeze actually took. This is the same class of hazard as
`getSaveFile()` clobbering the save it measures — the test destroying the thing it is
checking — arriving from a different direction.

### What I did NOT test — be clear about this

- **No in-game SAVE was ever reached.** Wario Land 4 saves on completing a level or
  from the map screen, and I did not clear Hall of Hieroglyphs — that was explicitly
  out of scope. Save persistence is verified at the **cartridge-SRAM layer**: the
  game's own SRAM image and a chosen marker both survive a real reload intact. What is
  **unverified** is that a player's saved progress reloads into a continuable game.
- **No long-form play.** Verified movement in the first level and nothing beyond it.
  No level completion, no boss, no minigames, no shop, no second passage, no ending.
  Wario gets stuck against an obstacle at x=2337 in the test run; getting past it is
  the tutorial's actual puzzle and was not attempted.
- **Headless Chrome 151 only.** No Firefox, no Safari, no real mobile browser.
- **No touch controls.** Keyboard and gamepad only.
- **The gamepad path is unverified** — written against the Standard Gamepad mapping,
  but no controller was attached.
- **Audio is unverified.** The code to drain mGBA's buffer into a ScriptProcessor
  exists and is wired to the unmute button, but every test ran muted by rule, so it
  has never been heard. Treat sound as untested.
- **The JP version was not built.** The repo supports `VERSION=jp` (md5
  `99c8ad779a16be513a9fdff502b6f5c2`) and no JP ROM is staged here.
- **The upstream `lilDavid` build was verified for a byte match only.** Its browser
  target was not separately tested — it produces identical ROM bytes, so the page
  would be running the same thing.
- **`make tools` was never run**, so the repo's own agbcc-from-source and venv paths
  are untested by me; I substituted the shared prebuilt and system pyyaml.
- The poisoned-baserom differential has a small, bounded blind spot: a source-built
  byte that coincidentally equalled *both* poison bytes would be miscounted as
  ROM-derived. With two independent generators that is ~1 byte in 65,000, far below
  the precision of any claim made from it.

---

## 5. Proposed catalog fragment

Schema per `shared/catalog-schema.md`. Do not merge mechanically — `source`,
`embedUrl` and `verification.date` are placeholders until this is published.

```json
{
  "id": "wario-land-4",
  "title": "Wario Land 4",
  "aliases": ["warioland4", "wario land 4", "wl4"],
  "year": 2001,
  "genre": "Platformer",
  "kind": "Decompilation",
  "mode": "files",
  "engine": "the TsilaAllaoui/warioland4 decompilation, built to a matching ROM and run on a WebAssembly build of mGBA",
  "description": "Raid a cursed pyramid as Wario: smash, dash and transform through five passages against the clock.",
  "overview": "Wario Land 4 built from the TsilaAllaoui/warioland4 decompilation, pinned at bfbbb8f4. The build is byte-identical to a retail (USA, Europe) cartridge dump — sha1 b9fe05a8080e124b67bce6a623234ee3b518a2c1, md5 5fe47355a33e3fabec2a1607af88a404. The page runs it on a direct WebAssembly build of mGBA's core, 664 KB, with no emulator frontend in between. You supply your own ROM: it is read in your browser with the File API straight into the emulator's memory. The page is static files with no server component, and its Content-Security-Policy forbids any connection to another origin, so the ROM cannot leave the device.",
  "source": "https://github.com/andrewnakas/warioland4-web",
  "engineLicense": "TsilaAllaoui/warioland4 (fork of lilDavid/warioland4); mGBA core MPL-2.0",
  "assetLicense": "None distributed — the player supplies their own ROM",
  "assetRequirements": "Your own Wario Land 4 ROM, (USA, Europe), 8 MB, sha1 b9fe05a8080e124b67bce6a623234ee3b518a2c1. It is read in your browser and never uploaded.",
  "controls": [
    "Arrow keys — D-pad",
    "X — A",
    "Z — B",
    "A / S — L / R",
    "Enter — Start",
    "Shift — Select",
    "Gamepad — any standard controller (untested)"
  ],
  "saveInstructions": "Wario Land 4 has a battery save. The cartridge SRAM is mirrored into this browser's storage and restored automatically on reload, keyed by the ROM's game code. There are also save-state buttons. Clearing site data removes everything, including the cached ROM.",
  "limitations": [
    "You must supply your own ROM; none is distributed.",
    "A matching build is not a finished decompilation: about a third of the ROM image is still copied verbatim out of your own ROM at build time, and much of the rest is machine-transcribed data tables. The project's own README calls itself work-in-progress.",
    "Verified only as far as moving and jumping in the first level, Hall of Hieroglyphs. No level was completed and nothing beyond the first level has been play-tested.",
    "Reaching an in-game save was not tested. Save persistence is verified at the cartridge-SRAM layer — the game's own save image survives a page reload byte-for-byte — but not by reloading a saved game.",
    "Sound is implemented but has never been listened to; all testing was muted.",
    "Keyboard and gamepad only; no on-screen touch controls, and the gamepad path is untested.",
    "Tested in headless Chrome only.",
    "US/EU version only; the Japanese ROM was not built or tested."
  ],
  "inputs": ["Keyboard", "Gamepad"],
  "downloadMB": 1,
  "complete": false,
  "color": "#e8b22e",
  "shelf": "decomp",
  "platform": "Game Boy Advance",
  "launch": "embed",
  "touch": false,
  "embedUrl": "https://andrewnakas.github.io/warioland4-web/",
  "verification": {
    "status": "smoke-tested",
    "date": null,
    "browsers": ["Chrome 151 (headless)"],
    "scope": "Muted headless run: boot through the file-select and map screens into Hall of Hieroglyphs, with gameplay confirmed from the game's own gMainGameMode and gWarioData rather than from a screenshot. Cartridge-SRAM persistence across a real page reload, with the save detector validated against a deliberately broken control arm. No level completed and no in-game save reached.",
    "playthrough": false
  },
  "image": "/images/wario-land-4.png"
}
```

---

## 6. Layout

```
games/warioland4/
  STATUS.md                      this file
  .gitignore                     no ROMs, no extracted assets, no build output
  tools/
    pngstat.py                   stdlib PNG brightness (copied from pokefirered)
    cdp.py                       CDP client (copied from pokefirered; unused by the
                                 final harness, which uses node's native WebSocket)
    save_mechanism.py            the EmulatorJS original, kept for provenance
    canvas_luma.py               crops a screenshot to the canvas rect for pngstat
  upstream/
    TsilaAllaoui/                the fork @ bfbbb8f (detached), CHOSEN
    lilDavid/                    upstream @ abb7800 (detached), also matches
  web/
    Makefile                     all / test / selftest / browsercheck / savecheck / check
    src/shim.c                   mCore -> JS surface, 32 KiB SRAM, bus reads
    src/index.html               the page (CSP, no inline script or style)
    src/app.js  src/app.css      page logic and styling, separate so CSP stays strict
    test/symbols.mjs             linker-map parser + GameMode / WarioData constants
    test/gba.mjs                 node wrapper around the wasm core
    test/core-smoke.mjs          core test (VJ dump dir writes PPM frames)
    test/browser-check.mjs       CDP harness, drives the real file picker
    test/save-check.mjs          deterministic save mechanism, with a control arm
    test/run-browser-check.sh    serves dist/, headless Chrome, tears down
    test/run-save-check.sh       same, for the save test
    dist/                        build output (gitignored)
```

### Three things worth knowing before touching this

**The shim must be compiled with libmgba's exact `-D` set.** `struct mCore`'s layout
depends on `ENABLE_DEBUGGERS`, `ENABLE_VFS`, `ENABLE_DIRECTORIES` and friends. Get it
wrong and every function pointer in the vtable reads back as `NULL` — no link error,
just a "null function or function signature mismatch" trap at the first call. The
Makefile therefore *derives* the defines from the mGBA build's own `flags.make` and
refuses to build if it cannot read them.

**The debug port is ephemeral and the page echoes a nonce.** Eighteen agents share
this box; a hardcoded `--remote-debugging-port` will cheerfully attach to someone
else's browser and hand back their page, which has already produced a run on this
fleet that graded the wrong game. The runners use `--remote-debugging-port=0` with a
private `--user-data-dir`, and the harness requires the live document to echo a URL
nonce — which also covers the fact that `Page.navigate` leaves `Runtime.evaluate`
pointing at the *old* document for a short window.

**A leftover tab blocks `indexedDB.deleteDatabase()` forever.** It does not error, it
simply never resolves, which looks exactly like a hung core. Both runners close every
existing page target before they start.
