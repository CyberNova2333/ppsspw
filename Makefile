# All emulator and bundled dependency sources live in this repository.
# Requires an activated Emscripten SDK for wasm-* targets (Linux / WSL).
.PHONY: help app-install app-build app-build-pages wasm-root-check wasm-ffmpeg wasm-dev wasm-release pages serve test

APP_DIR := wasm-page
WASM_ROOT := deps/ppsspp-wasm
WASM_JOBS ?= -j4
WASM_FFMPEG_JOBS ?= 4
WASM_ENABLE_LTO ?= OFF
CMAKE ?= $(or $(wildcard /usr/bin/cmake),cmake)
PYTHON ?= python3
BIND ?= 127.0.0.1
PORT ?= 17881
WASM_FFMPEG_DIR := $(abspath $(WASM_ROOT)/build-ffmpeg-wasm/install)

help:
	@echo "app-install: install locked web dependencies; app-build: build web UI"
	@echo "wasm-release: compile the vendored emulator; pages: build complete player"
	@echo "serve: preview packaged player; test: run web behavior tests"

app-install:
	npm --prefix $(APP_DIR) ci

app-build:
	npm --prefix $(APP_DIR) run build:pages

wasm-root-check:
	@test -f "$(WASM_ROOT)/CMakeLists.txt" || (echo "Missing vendored core source" >&2; exit 1)
	@test -f "$(WASM_ROOT)/ffmpeg/configure" || (echo "Missing vendored FFmpeg source" >&2; exit 1)

wasm-ffmpeg: wasm-root-check
	WASM_FFMPEG_JOBS="$(WASM_FFMPEG_JOBS)" bash scripts/build-ffmpeg-wasm.sh "$(WASM_ROOT)"

wasm-dev: wasm-ffmpeg
	$(MAKE) -C $(WASM_ROOT) wasm-dev-config CMAKE=$(CMAKE)
	emcmake $(CMAKE) -S "$(WASM_ROOT)" -B "$(WASM_ROOT)/build-wasm" -DUSE_FFMPEG=ON -DFFMPEG_DIR="$(WASM_FFMPEG_DIR)"
	$(MAKE) -C $(WASM_ROOT) wasm-dev-build CMAKE=$(CMAKE) WASM_JOBS="$(WASM_JOBS)"

wasm-release: wasm-ffmpeg
	$(MAKE) -C $(WASM_ROOT) wasm-release-config CMAKE=$(CMAKE)
	emcmake $(CMAKE) -S "$(WASM_ROOT)" -B "$(WASM_ROOT)/build-wasm-release" -DWASM_ENABLE_LTO=$(WASM_ENABLE_LTO) -DUSE_FFMPEG=ON -DFFMPEG_DIR="$(WASM_FFMPEG_DIR)"
	$(MAKE) -C $(WASM_ROOT) wasm-release-build CMAKE=$(CMAKE) WASM_JOBS="$(WASM_JOBS)"

app-build-pages: app-build
	$(PYTHON) scripts/package-player.py

pages: wasm-release app-build-pages

serve:
	$(PYTHON) server/serve-player.py --bind "$(BIND)" --port "$(PORT)"

test:
	npm --prefix $(APP_DIR) test
	$(PYTHON) -m unittest discover -s server/player-tests -v
