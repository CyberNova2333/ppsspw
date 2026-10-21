.PHONY: wasm-dev-config wasm-dev-build wasm-dev wasm-release-config wasm-release-build wasm-release wasm-config wasm-build config-wasm build-wasm

WASM_DEV_BUILD_DIR ?= build-wasm
WASM_RELEASE_BUILD_DIR ?= build-wasm-release
WASM_JOBS ?= -j
WASM_MAIN_LOOP_FPS ?= 60
WASM_INITIAL_MEMORY ?= 536870912
WASM_MAXIMUM_MEMORY ?= 4294967296
CMAKE ?= $(or $(wildcard /usr/bin/cmake),cmake)

WASM_COMMON_CMAKE_ARGS := \
	-G Ninja \
	-DUSING_GLES2=ON \
	-DUSING_EGL=OFF \
	-DVULKAN=OFF \
	-DUSE_NO_MMAP=ON \
	-DUSE_FFMPEG=OFF \
	-DUSE_DISCORD=OFF \
	-DUSE_MINIUPNPC=OFF \
	-DUSE_SYSTEM_LIBSDL2=OFF \
	-DUSE_SYSTEM_LIBPNG=OFF \
	-DUSE_SYSTEM_FREETYPE=OFF \
	-DUSE_SYSTEM_LIBZIP=OFF \
	-DWASM_MAIN_LOOP_FPS=$(WASM_MAIN_LOOP_FPS) \
	-DWASM_INITIAL_MEMORY=$(WASM_INITIAL_MEMORY) \
	-DWASM_MAXIMUM_MEMORY=$(WASM_MAXIMUM_MEMORY)

wasm-dev-config:
	emcmake $(CMAKE) -S . -B $(WASM_DEV_BUILD_DIR) $(WASM_COMMON_CMAKE_ARGS) -DCMAKE_BUILD_TYPE=RelWithDebInfo -DWASM_MAX_PERF=OFF -DWASM_ENABLE_LTO=OFF -DWASM_MALLOC=emmalloc

wasm-dev-build:
	$(CMAKE) --build $(WASM_DEV_BUILD_DIR) $(WASM_JOBS)

wasm-dev: wasm-dev-config wasm-dev-build

wasm-release-config:
	emcmake $(CMAKE) -S . -B $(WASM_RELEASE_BUILD_DIR) $(WASM_COMMON_CMAKE_ARGS) -DCMAKE_BUILD_TYPE=Release -DWASM_MAX_PERF=ON -DWASM_ENABLE_LTO=OFF -DWASM_MALLOC=mimalloc

wasm-release-build:
	$(CMAKE) --build $(WASM_RELEASE_BUILD_DIR) $(WASM_JOBS)

wasm-release: wasm-release-config wasm-release-build

wasm-config: wasm-dev-config
wasm-build: wasm-dev-build
config-wasm: wasm-dev-config
build-wasm: wasm-dev-build

docker:
	docker run --rm -it \
	-v $(CURDIR):/src \
	-w /src \
	emscripten/emsdk:latest \
	bash
