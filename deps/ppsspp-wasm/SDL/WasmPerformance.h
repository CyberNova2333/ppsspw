#pragma once

#ifdef __EMSCRIPTEN__
// Called only by the thread running NativeFrame, after that frame returns.
void WasmPublishPerformance(double frameMilliseconds);

// Read-only scalar ABI. Read slot 13 before and after a snapshot; both values
// must be equal and even. No core state is read directly by the browser thread.
// 0 schema version (2), 1 initialized, 2 actual FPS, 3 estimated target FPS,
// 4 emulated speed percent, 5 vblanks/second, 6 cumulative vblanks,
// 7 cumulative actual flips, 8 cumulative emulated microseconds,
// 9 last NativeFrame wall time in ms (including pacing and render waits),
// 10 snapshot age in ms (-1 before the first snapshot), 11 target vblanks/second,
// 12 emulating, 13 snapshot sequence,
// 14 configured initial memory bytes, 15 configured maximum memory bytes,
// 16 configured compute threads, 17 configured prewarmed pthreads (0 = auto),
// 18 actual ThreadManager compute threads, 19 actual ThreadManager total threads,
// 20 effective CPU backend (-1 uninitialized, 0 interpreter, 2 IR interpreter,
//    4 unsupported native-JIT fallback),
// 21 completed heap resize requests, 22 successful requests, 23 failed requests,
// 24 cumulative resize request milliseconds, 25 longest request milliseconds,
// 26 current Wasm linear memory capacity in bytes.
// Resize requests cover the allocator's emscripten_resize_heap calls on all
// threads, including internal retries; they are not Memory.grow call counts.
// Capacity is not live allocation size or browser process memory.
// Unknown slots return -1.
extern "C" double ppssppGetPerformanceMetric(int slot);
#endif
