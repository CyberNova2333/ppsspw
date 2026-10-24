#ifdef __EMSCRIPTEN__
#include "SDL/WasmPerformance.h"

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <emscripten/emscripten.h>

#include "Common/TimeUtil.h"
#include "Core/Config.h"
#include "Core/Core.h"
#include "Core/CoreTiming.h"
#include "Core/HW/Display.h"
#include "Core/System.h"

namespace {
// Atomic payloads avoid a C++ data race even when a reader retries a snapshot.
// Sequential consistency makes the even sequence a publication boundary.
static_assert(std::atomic<double>::is_always_lock_free, "Wasm metrics require nonblocking atomic reads");
std::atomic<double> metrics[13]{};
std::atomic<double> publishedAt{};
std::atomic<uint32_t> sequence{};
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
	publishedAt.store(now);
	sequence.fetch_add(1);
}

extern "C" EMSCRIPTEN_KEEPALIVE double ppssppGetPerformanceMetric(int slot) {
	if (slot == 0) return 1.0;
	if (slot == 13) return sequence.load();
	if (slot == 10) {
		const double timestamp = publishedAt.load();
		return sequence.load() == 0 ? -1.0 : std::max(0.0, (time_now_d() - timestamp) * 1000.0);
	}
	return slot > 0 && slot < 13 ? metrics[slot].load() : -1.0;
}
#endif
