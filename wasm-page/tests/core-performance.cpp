// Deterministic inputs for scripts/test-wasm-performance.py.
#include <cassert>
#include <atomic>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <thread>
#include <emscripten/heap.h>
#include "Common/Thread/ThreadManager.h"
#include "SDL/WasmPerformance.h"
#include "Core/Config.h"
#include "Core/CoreTiming.h"
#include "Core/System.h"

TestConfig g_Config;
ThreadManager g_threadManager;
static TestCoreParameter coreParameter;
TestCoreParameter &PSP_CoreParameter() { return coreParameter; }
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
	Expect(0, 2); Expect(1, 0); Expect(10, -1); Expect(-1, -1); Expect(27, -1);
	WasmPublishPerformance(16);
	Expect(13, 2); Expect(1, 0); Expect(12, 0);
	Expect(14, 16777216); Expect(15, 134217728); Expect(16, 2); Expect(17, 2);
	Expect(18, 2); Expect(19, 6); Expect(20, -1);
	Expect(26, emscripten_get_heap_size());

	initialized = running = true;
	wallTime = 11; vblanks = 60; flips = 30; emulatedUs = 1000000;
	WasmPublishPerformance(16);
	Expect(1, 1); Expect(12, 1); Expect(2, 0);
	Expect(20, 2);
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
	Expect(20, -1);
	initialized = true;
	coreParameter.cpuCore = CPUCore::INTERPRETER;
	WasmPublishPerformance(0); Expect(20, 0);
	coreParameter.cpuCore = CPUCore::JIT;
	WasmPublishPerformance(0); Expect(20, 4);
	coreParameter.cpuCore = CPUCore::JIT_IR;
	WasmPublishPerformance(0); Expect(20, 4);
	g_threadManager.initialized = false;
	WasmPublishPerformance(0); Expect(18, 0); Expect(19, 0);

	// Exercise the real SDK resize implementation, first on this thread and
	// then through a worker's allocator. A main-thread JS hook would miss this.
	const double beforeRequests = ppssppGetPerformanceMetric(21);
	const double beforeSuccesses = ppssppGetPerformanceMetric(22);
	const size_t beforeCapacity = emscripten_get_heap_size();
	assert(emscripten_resize_heap(beforeCapacity + 65536));
	WasmPublishPerformance(0);
	Expect(21, beforeRequests + 1); Expect(22, beforeSuccesses + 1);
	assert(ppssppGetPerformanceMetric(26) > beforeCapacity);
	const double workerRequests = ppssppGetPerformanceMetric(21);
	const double workerSuccesses = ppssppGetPerformanceMetric(22);
	const size_t workerCapacity = emscripten_get_heap_size();
	std::thread allocation([] {
		volatile unsigned char *bytes = static_cast<unsigned char *>(std::malloc(24 * 1024 * 1024));
		assert(bytes);
		bytes[0] = 7;
		bytes[24 * 1024 * 1024 - 1] = 9;
		assert(bytes[0] + bytes[24 * 1024 * 1024 - 1] == 16);
		std::free(const_cast<unsigned char *>(bytes));
	});
	allocation.join();
	WasmPublishPerformance(0);
	assert(ppssppGetPerformanceMetric(21) > workerRequests);
	assert(ppssppGetPerformanceMetric(22) > workerSuccesses);
	assert(ppssppGetPerformanceMetric(26) > workerCapacity);

	// Concurrent failures must be counted exactly once, without changing the
	// allocator's return values or publishing a partially updated aggregate.
	const double beforeFailures = ppssppGetPerformanceMetric(23);
	const double beforeConcurrentRequests = ppssppGetPerformanceMetric(21);
	std::atomic<int> ready{0};
	std::atomic<bool> proceed{false};
	auto failResize = [&] {
		ready.fetch_add(1);
		while (!proceed.load()) {}
		for (int i = 0; i < 40; ++i) assert(!emscripten_resize_heap(160 * 1024 * 1024));
	};
	std::thread first(failResize), second(failResize);
	while (ready.load() != 2) {}
	proceed.store(true);
	for (int i = 0; i < 40; ++i) {
		WasmPublishPerformance(0);
		Expect(21, ppssppGetPerformanceMetric(22) + ppssppGetPerformanceMetric(23));
	}
	first.join(); second.join();
	WasmPublishPerformance(0);
	Expect(21, beforeConcurrentRequests + 80); Expect(23, beforeFailures + 80);
	Expect(21, ppssppGetPerformanceMetric(22) + ppssppGetPerformanceMetric(23));
	assert(std::isfinite(ppssppGetPerformanceMetric(24)) && ppssppGetPerformanceMetric(24) >= 0);
	assert(ppssppGetPerformanceMetric(24) >= ppssppGetPerformanceMetric(25));
	Expect(26, emscripten_get_heap_size());
	assert(static_cast<int>(ppssppGetPerformanceMetric(13)) % 2 == 0);
	std::puts("Performance metric tests passed: rates, pause/resume, rollback, age, resources, concurrent allocator resize requests");
}
