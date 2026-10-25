#!/bin/sh
# Build the LibreDWG WebAssembly engine (web/engine/dwg2dxf.{js,wasm}).
#
# Requirements: Emscripten (emcc on PATH), a POSIX shell, and the official
# LibreDWG release tarball unpacked somewhere (verified sha256 in README.md).
# Make is not required: config.h comes from LibreDWG's own configure script
# and the sources are compiled directly.
#
#   LIBREDWG_SRC=/path/to/libredwg-0.14 BUILD_DIR=/tmp/build-wasm sh engine/build.sh
#
# On Windows (Git Bash) a stub pkg-config is needed because configure insists
# on finding one; set PKG_CONFIG to a script that only answers --version.
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
OUT=${OUT:-$HERE/../web/engine}
: "${LIBREDWG_SRC:?set LIBREDWG_SRC to the unpacked libredwg-0.14 directory}"
BUILD_DIR=${BUILD_DIR:-$HERE/../build-wasm}
JOBS=${JOBS:-8}
CFLAGS_OPT=${CFLAGS_OPT:--O2 -DNDEBUG}

mkdir -p "$BUILD_DIR" "$OUT"
BUILD_DIR=$(cd "$BUILD_DIR" && pwd)
LIBREDWG_SRC=$(cd "$LIBREDWG_SRC" && pwd)

# 0. patched copy of the pristine release (patches/ documents every change)
PATCHED="$BUILD_DIR/libredwg-patched"
if [ ! -f "$PATCHED/.patched" ]; then
  rm -rf "$PATCHED"
  cp -r "$LIBREDWG_SRC" "$PATCHED"
  for p in "$HERE"/patches/*.patch; do
    [ -f "$p" ] || continue
    echo "applying $(basename "$p")"
    patch -d "$PATCHED" -p1 --no-backup-if-mismatch < "$p"
  done
  touch "$PATCHED/.patched"
fi
LIBREDWG_SRC="$PATCHED"

# 1. config.h via LibreDWG's configure (DXF output on, JSON and DWG writing off)
if [ ! -f "$BUILD_DIR/src/config.h" ]; then
  (cd "$BUILD_DIR" && CC=emcc LD=emcc AR=emar RANLIB=emranlib NM=llvm-nm \
    CFLAGS="$CFLAGS_OPT" sh "$LIBREDWG_SRC/configure" \
    --host=wasm32-unknown-emscripten --enable-release --disable-shared \
    --disable-bindings --disable-python --disable-docs --disable-json \
    --disable-write --disable-werror --disable-dependency-tracking \
    > configure.log 2>&1) || true
  [ -f "$BUILD_DIR/src/config.h" ] || { echo "configure failed, see $BUILD_DIR/configure.log"; exit 1; }
fi

# 2. compile the library sources needed for DWG reading + DXF writing
#    (list from src/Makefile.am with DISABLE_JSON and !USE_WRITE)
SRCS="dwg.c common.c codepages.c bits.c logging.c decode.c decode2.c
decode_r11.c decode_r2007.c reedsolomon.c print.c free.c hash.c dynapi.c
classes.c dwg_api.c objects.c geom.c out_dxf.c out_dxfb.c"
INC="-I$BUILD_DIR/src -I$LIBREDWG_SRC/src -I$LIBREDWG_SRC/include"
mkdir -p "$BUILD_DIR/obj"
for s in $SRCS; do echo "$s"; done | xargs -P "$JOBS" -I{} sh -c \
  "emcc $CFLAGS_OPT $INC -c '$LIBREDWG_SRC/src/{}' -o '$BUILD_DIR/obj/{}.o' 2>>'$BUILD_DIR/compile.log' || { echo 'compile failed: {}'; exit 255; }"
emcc $CFLAGS_OPT $INC -c "$HERE/wasm_dwg2dxf.c" -o "$BUILD_DIR/obj/wasm_dwg2dxf.o"

# 3. link. Classic (non-ES-module) glue so it loads with importScripts() in
#    a worker on every Safari version that has WebAssembly; also runs in Node
#    for the test harness. Memory grows on demand, capped at 2 GiB because
#    iOS Safari tends to refuse larger reservations.
emcc $CFLAGS_OPT "$BUILD_DIR"/obj/*.o -o "$OUT/dwg2dxf.js" \
  -sMODULARIZE=1 -sEXPORT_NAME=createDwg2Dxf \
  -sENVIRONMENT=web,worker,node \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=64MB -sMAXIMUM_MEMORY=2GB \
  -sSTACK_SIZE=4MB \
  -sFORCE_FILESYSTEM=1 -sEXIT_RUNTIME=0 \
  -sEXPORTED_FUNCTIONS=_w_convert,_malloc,_free \
  -sEXPORTED_RUNTIME_METHODS=FS,ccall,HEAPU8 \
  -sINCOMING_MODULE_JS_API=print,printErr,locateFile

ls -l "$OUT"
