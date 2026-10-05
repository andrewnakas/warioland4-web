# Browser target for Wario Land 4.
#
# Builds a small shim against mGBA's mCore API, compiled to wasm, and emits a
# static page that takes the user's own ROM from a file picker. No ROM, and no
# bytes extracted from one, are produced or consumed by this Makefile.
#
#   make              build dist/ (the shippable page)
#   make test         also build the node-side core harness
#   make selftest     run the muted core test against ~/decompfleet/roms
#   make browsercheck run the real page in headless Chrome, muted
#   make savecheck    deterministic save-mechanism test (event dispatch)
#   make check        all of the above
#   make clean
#
# emcc must be on PATH:
#   source ~/decompfleet/shared/emsdk/emsdk_env.sh

# mGBA is built once per box and shared. This is the pokeruby agent's build,
# which that agent explicitly offered for reuse (the core is GBA-generic, and
# rebuilding it would cost ~1.5 G of disk for an identical artifact). The exact
# emcmake line that produced it is recorded in ../STATUS.md so this is
# reproducible without it.
MGBA      ?= $(HOME)/decompfleet/games/pokeruby/ref/mgba
MGBA_BUILD = $(MGBA)/build-wasm
LIBMGBA    = $(MGBA_BUILD)/libmgba.a
ROMS      ?= $(HOME)/decompfleet/roms
ROM       ?= $(ROMS)/warioland4.gba
MAP       ?= $(CURDIR)/../upstream/TsilaAllaoui/build/us/warioland4_us.map
SHOTS     ?=

# The shim reads struct mCore through mGBA's headers, so it MUST be compiled
# with the same -D set as libmgba.a or the fields land at different offsets and
# every vtable entry reads back as NULL -- with no link error, just a "null
# function or function signature mismatch" trap at the first call. Deriving the
# list from the build instead of restating it is deliberate.
MGBA_DEFS = $(shell sed -n 's/^C_DEFINES = //p' $(MGBA_BUILD)/CMakeFiles/mgba.dir/flags.make)

CPPFLAGS = -I $(MGBA)/include -I $(MGBA)/src -I $(MGBA_BUILD)/include \
           -D_GNU_SOURCE -DPATH_MAX=4096 -DDISABLE_THREADING $(MGBA_DEFS)

# No audio device, no filesystem, no GL: the page owns the canvas and only
# creates an AudioContext if the user explicitly unmutes.
EMFLAGS = -s MODULARIZE=1 -s EXPORT_NAME=createGBA \
          -s ALLOW_MEMORY_GROWTH=1 -s INITIAL_MEMORY=64MB \
          -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap","UTF8ToString","HEAPU8","HEAPU32","HEAP16"]' \
          -s EXPORTED_FUNCTIONS='["_malloc","_free"]' \
          -s FILESYSTEM=0

PAGE = dist/index.html dist/app.js dist/app.css

.PHONY: all test selftest browsercheck savecheck check clean checklib

all: dist/warioland4.js $(PAGE)

checklib:
	@test -f $(LIBMGBA) || { \
	  echo "missing $(LIBMGBA)"; \
	  echo "build it first -- the exact emcmake line is in ../STATUS.md"; exit 1; }
	@test -n "$(MGBA_DEFS)" || { \
	  echo "could not read C_DEFINES from the mgba build; refusing to build with"; \
	  echo "mismatched struct layouts (every mCore function pointer would be NULL)"; exit 1; }

dist/warioland4.js: src/shim.c $(LIBMGBA) Makefile | checklib
	@mkdir -p dist
	emcc -O3 $< $(LIBMGBA) $(CPPFLAGS) -o $@ $(EMFLAGS) -s ENVIRONMENT=web

dist/%: src/%
	@mkdir -p dist
	cp $< $@

test: test/core-node.js

test/core-node.js: src/shim.c $(LIBMGBA) Makefile | checklib
	@mkdir -p test
	emcc -O2 $< $(LIBMGBA) $(CPPFLAGS) -o $@ $(EMFLAGS) -s ENVIRONMENT=node

# Core level, outside a browser. Fast, and isolates core bugs from page bugs.
selftest: test/core-node.js
	node test/core-smoke.mjs $(ROM) $(MAP)

# The real page in headless Chrome, ROM fed through the actual file picker.
browsercheck: all
	./test/run-browser-check.sh $(ROM) $(MAP) $(SHOTS)

# Save mechanism, the deterministic way: dispatch the lifecycle events rather
# than racing a real navigation. See ../STATUS.md for why the reload-soak alone
# is not trusted on this box.
savecheck: all
	./test/run-save-check.sh $(ROM)

check: selftest browsercheck savecheck

clean:
	rm -rf dist test/core-node.js test/core-node.wasm
