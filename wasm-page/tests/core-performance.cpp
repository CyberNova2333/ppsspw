// Deterministic inputs for scripts/test-wasm-performance.py.
#include <cassert>
#include <cmath>
#include <cstdio>
#include "SDL/WasmPerformance.h"
#include "Core/Config.h"
#include "Core/CoreTiming.h"
#include "Core/System.h"

TestConfig g_Config;
static double wallTime = 10.0;
static bool initialized = false;
static bool running = false;
static int vblanks = 0;
static int flips = 0;
static uint64_t emulatedUs = 0;

double time_now_d() { return wallTime; }
bool PSP_IsInited() { return initialized; }
int GetUIState() { return running ? UISTATE_INGAME : UISTATE_MENU; }
bool Core_IsActive() { return running; }
bool Core_IsStepping() { return false; }
int __DisplayGetNumVblanks() { return vblanks; }
int __DisplayGetFlipCount() { return flips; }
void __DisplayGetFPS(float *, float *target, float *) { *target = 30.0f; }
namespace CoreTiming { uint64_t GetGlobalTimeUs() { return emulatedUs; } }

static void Expect(int slot, double value) {
	assert(std::abs(ppssppGetPerformanceMetric(slot) - value) < 0.000001);
}

int main() {
	Expect(0, 1); Expect(1, 0); Expect(10, -1); Expect(-1, -1); Expect(14, -1);
	WasmPublishPerformance(16);
	Expect(13, 2); Expect(1, 0); Expect(12, 0);

	initialized = running = true;
	wallTime = 11; vblanks = 60; flips = 30; emulatedUs = 1000000;
	WasmPublishPerformance(16);
	Expect(1, 1); Expect(12, 1); Expect(2, 0);
	// The window lasts 1.5 seconds: raw flip counts must not be reported as FPS.
	wallTime = 12.5; vblanks = 150; flips = 75; emulatedUs = 2500000;
	WasmPublishPerformance(24);
	Expect(2, 30); Expect(3, 30); Expect(4, 100); Expect(5, 60); Expect(9, 24);
	Expect(6, 150); Expect(7, 75); Expect(8, 2500000); Expect(11, 60 / 1.001);
	wallTime = 12.75; Expect(10, 250);

	running = false; wallTime = 13;
	WasmPublishPerformance(3);
	Expect(2, 0); Expect(4, 0); Expect(12, 0);
	running = true; wallTime = 14;
	WasmPublishPerformance(10);
	wallTime = 15; vblanks = 180; flips = 90; emulatedUs = 3000000;
	WasmPublishPerformance(20);
	Expect(2, 15); Expect(4, 50); Expect(5, 30);

	// A rollback inside the current measurement window also invalidates rates.
	wallTime = 15.2; vblanks = 192; flips = 96; emulatedUs = 3200000;
	WasmPublishPerformance(10);
	wallTime = 15.3; vblanks = 186; flips = 93; emulatedUs = 3100000;
	WasmPublishPerformance(10);
	Expect(2, 0); Expect(4, 0);
	wallTime = 16; vblanks = 1; flips = 1; emulatedUs = 1;
	WasmPublishPerformance(1);
	Expect(2, 0); Expect(4, 0);
	initialized = false; wallTime = 17;
	WasmPublishPerformance(0);
	Expect(1, 0); Expect(6, 0); Expect(8, 0);
	assert(static_cast<int>(ppssppGetPerformanceMetric(13)) % 2 == 0);
	std::puts("Performance metric tests passed: rates, pause/resume, rollback, age, schema");
}
