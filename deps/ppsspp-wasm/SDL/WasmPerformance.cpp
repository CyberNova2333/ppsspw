#ifdef __EMSCRIPTEN__
#include "SDL/WasmPerformance.h"

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <emscripten/emscripten.h>
#include <emscripten/heap.h>

#include "Common/Thread/ThreadManager.h"
#include "Common/TimeUtil.h"
#include "Core/Config.h"
#include "Core/ConfigValues.h"
#include "Core/Core.h"
#include "Core/CoreTiming.h"
#include "Core/HW/Display.h"
#include "Core/System.h"

namespace {
// Atomic payloads avoid a C++ data race even when a reader retries a snapshot.
// Sequential consistency makes the even sequence a publication boundary.
static_assert(std::atomic<double>::is_always_lock_free, "Wasm metrics require nonblocking atomic reads");
std::atomic<double> metrics[27]{};
std::atomic<double> publishedAt{};
std::atomic<uint32_t> sequence{};

struct HeapResizeStats {
	uint64_t requests = 0;
	uint64_t successes = 0;
	uint64_t failures = 0;
	double totalMilliseconds = 0.0;
	double maxMilliseconds = 0.0;
};

// Growth itself stays outside this lock. Only the short, allocation-free
// bookkeeping section is serialized, so readers never mix partial completions.
std::atomic_flag heapResizeLock = ATOMIC_FLAG_INIT;
HeapResizeStats heapResizeStats{};

class HeapResizeGuard {
public:
	HeapResizeGuard() {
		while (heapResizeLock.test_and_set(std::memory_order_acquire)) {}
	}
	~HeapResizeGuard() { heapResizeLock.clear(std::memory_order_release); }
};

int EffectiveCpuBackend(bool initialized) {
	if (!initialized) return -1;
	switch (PSP_CoreParameter().cpuCore) {
	case CPUCore::INTERPRETER: return 0;
	case CPUCore::IR_INTERPRETER: return 2;
	// CreateNativeJit selects FakeJit for the Wasm target. Do not report an
	// actual native JIT merely because a saved setting requested one.
	case CPUCore::JIT:
	case CPUCore::JIT_IR: return 4;
	default: return -1;
	}
}
}

// Linker wrapping retains the SDK's implementation and allocation policy.
// All native threads share these counters, including allocations before main.
extern "C" bool __real_emscripten_resize_heap(size_t requestedSize);
extern "C" bool __wrap_emscripten_resize_heap(size_t requestedSize) {
	const double started = emscripten_get_now();
	const bool succeeded = __real_emscripten_resize_heap(requestedSize);
	const double elapsed = emscripten_get_now() - started;
	const double milliseconds = std::isfinite(elapsed) ? std::max(0.0, elapsed) : 0.0;
	HeapResizeGuard guard;
	heapResizeStats.requests++;
	if (succeeded) heapResizeStats.successes++;
	else heapResizeStats.failures++;
	heapResizeStats.totalMilliseconds += milliseconds;
	heapResizeStats.maxMilliseconds = std::max(heapResizeStats.maxMilliseconds, milliseconds);
	return succeeded;
}

void WasmPublishPerformance(double frameMilliseconds) {
	const double now = time_now_d();
	const bool initialized = PSP_IsInited();
	const bool emulating = initialized && GetUIState() == UISTATE_INGAME && Core_IsActive() && !Core_IsStepping();
	const int vblanks = initialized ? __DisplayGetNumVblanks() : 0;
	const int flips = initialized ? __DisplayGetFlipCount() : 0;
	const uint64_t emulatedUs = initialized ? CoreTiming::GetGlobalTimeUs() : 0;
	float targetFps = 0.0f;
	if (initialized) {
		__DisplayGetFPS(nullptr, &targetFps, nullptr);
	}

	// These accumulators have one producer: the thread running NativeFrame.
	static bool wasEmulating = false;
	static double origin = 0.0;
	static int originVblanks = 0;
	static int originFlips = 0;
	static uint64_t originEmulatedUs = 0;
	static int lastVblanks = 0;
	static int lastFlips = 0;
	static uint64_t lastEmulatedUs = 0;
	static double actualFps = 0.0;
	static double vps = 0.0;
	static double speedPercent = 0.0;
	const bool reset = !emulating || !wasEmulating || vblanks < lastVblanks ||
		flips < lastFlips || emulatedUs < lastEmulatedUs || now <= origin;
	const double elapsed = now - origin;
	if (reset) {
		actualFps = vps = speedPercent = 0.0;
	} else if (elapsed >= 1.0) {
		actualFps = (flips - originFlips) / elapsed;
		vps = (vblanks - originVblanks) / elapsed;
		speedPercent = (emulatedUs - originEmulatedUs) / (elapsed * 10000.0);
	}
	if (reset || elapsed >= 1.0) {
		origin = now;
		originVblanks = vblanks;
		originFlips = flips;
		originEmulatedUs = emulatedUs;
	}
	wasEmulating = emulating;
	lastVblanks = vblanks;
	lastFlips = flips;
	lastEmulatedUs = emulatedUs;
	HeapResizeStats resize;
	{
		HeapResizeGuard guard;
		resize = heapResizeStats;
	}

	sequence.fetch_add(1);
	metrics[1].store(initialized ? 1.0 : 0.0);
	metrics[2].store(actualFps);
	metrics[3].store(std::isfinite(targetFps) ? std::max(0.0f, targetFps) : 0.0);
	metrics[4].store(speedPercent);
	metrics[5].store(vps);
	metrics[6].store(vblanks);
	metrics[7].store(flips);
	metrics[8].store(static_cast<double>(emulatedUs));
	metrics[9].store(std::isfinite(frameMilliseconds) ? std::max(0.0, frameMilliseconds) : 0.0);
	metrics[11].store(std::max(1, g_Config.iDisplayRefreshRate) / 1.001);
	metrics[12].store(emulating ? 1.0 : 0.0);
	metrics[14].store(static_cast<double>(PPSSPP_WASM_INITIAL_MEMORY));
	metrics[15].store(static_cast<double>(PPSSPP_WASM_MAXIMUM_MEMORY));
	metrics[16].store(PPSSPP_WASM_COMPUTE_THREADS);
	metrics[17].store(PPSSPP_WASM_PTHREAD_POOL_SIZE);
	metrics[18].store(g_threadManager.IsInitialized() ? g_threadManager.GetNumLooperThreads() : 0);
	metrics[19].store(g_threadManager.IsInitialized() ? g_threadManager.GetNumThreads() : 0);
	metrics[20].store(EffectiveCpuBackend(initialized));
	metrics[21].store(static_cast<double>(resize.requests));
	metrics[22].store(static_cast<double>(resize.successes));
	metrics[23].store(static_cast<double>(resize.failures));
	metrics[24].store(resize.totalMilliseconds);
	metrics[25].store(resize.maxMilliseconds);
	metrics[26].store(static_cast<double>(emscripten_get_heap_size()));
	publishedAt.store(now);
	sequence.fetch_add(1);
}

extern "C" EMSCRIPTEN_KEEPALIVE double ppssppGetPerformanceMetric(int slot) {
	if (slot == 0) return 2.0;
	if (slot == 13) return sequence.load();
	if (slot == 10) {
		const double timestamp = publishedAt.load();
		return sequence.load() == 0 ? -1.0 : std::max(0.0, (time_now_d() - timestamp) * 1000.0);
	}
	return slot > 0 && slot < 27 ? metrics[slot].load() : -1.0;
}
#endif
