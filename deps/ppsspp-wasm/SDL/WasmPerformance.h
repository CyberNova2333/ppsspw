#pragma once

#ifdef __EMSCRIPTEN__
// Called only by the thread running NativeFrame, after that frame returns.
void WasmPublishPerformance(double frameMilliseconds);

// Read-only scalar ABI. Read slot 13 before and after a snapshot; both values
// must be equal and even. No core state is read directly by the browser thread.
// 0 schema version (1), 1 initialized, 2 actual FPS, 3 estimated target FPS,
// 4 emulated speed percent, 5 vblanks/second, 6 cumulative vblanks,
// 7 cumulative actual flips, 8 cumulative emulated microseconds,
// 9 last NativeFrame wall time in ms (including pacing and render waits),
// 10 snapshot age in ms (-1 before the first snapshot), 11 target vblanks/second,
// 12 emulating, 13 snapshot sequence. Unknown slots return -1.
extern "C" double ppssppGetPerformanceMetric(int slot);
#endif
