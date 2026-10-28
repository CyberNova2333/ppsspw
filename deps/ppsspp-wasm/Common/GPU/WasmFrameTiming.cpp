#include "Common/GPU/WasmFrameTiming.h"

#ifdef PPSSPP_WASM_FRAME_TIMING
#include <atomic>
#include <cmath>
#include <limits>

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#define FRAME_TIMING_EXPORT EMSCRIPTEN_KEEPALIVE
#else
#define FRAME_TIMING_EXPORT
#endif

#ifndef PPSSPP_WASM_FRAME_TIMING_CAPACITY
#define PPSSPP_WASM_FRAME_TIMING_CAPACITY 8192
#endif
#ifndef PPSSPP_WASM_FRAME_TIMING_MAX_REQUESTS
#define PPSSPP_WASM_FRAME_TIMING_MAX_REQUESTS 0x3fffffff
#endif

namespace WasmFrameTiming {
namespace {
constexpr uint32_t kCapacity = PPSSPP_WASM_FRAME_TIMING_CAPACITY;
constexpr uint32_t kMaxRequests = PPSSPP_WASM_FRAME_TIMING_MAX_REQUESTS;
constexpr uint64_t kSafeInteger = 9007199254740991ULL;
constexpr uint64_t kMaxContext = std::numeric_limits<uint32_t>::max();
static_assert(kCapacity > 0 && kCapacity <= 8192);
static_assert(kMaxRequests > 0 && kMaxRequests <= 0x3fffffff);
static_assert(std::atomic<uint64_t>::is_always_lock_free, "Frame timing must not block the render thread");
static_assert(std::atomic<uint32_t>::is_always_lock_free);
static_assert(std::atomic<State>::is_always_lock_free && std::atomic<Reason>::is_always_lock_free);

std::atomic<uint64_t> timestamps[kCapacity]{};
std::atomic<uint64_t> sequence{}, contextEpoch{}, captureEpoch{};
std::atomic<uint64_t> startUs{}, endUs{};
std::atomic<uint32_t> count{}, captureId{}, acknowledgedId{};
std::atomic<State> state{State::Idle};
std::atomic<Reason> reason{Reason::None};
std::atomic<uint32_t> pendingRequest{}, nextRequestId{1};

Reason ContextReason() {
	const uint64_t current = contextEpoch.load();
	if (current > kMaxContext)
		return Reason::CounterExhausted;
	if (captureId.load() && captureEpoch.load() != current)
		return Reason::ContextChanged;
	return Reason::None;
}

void Invalidate(Reason failure) {
	reason.store(failure);
	state.store(State::Invalid);
}

void Append(double seconds) {
	if (!std::isfinite(seconds) || seconds < 0.0 || seconds * 1000000.0 > static_cast<double>(kSafeInteger)) {
		Invalidate(Reason::TimestampOutOfRange);
		return;
	}
	const uint64_t timestamp = static_cast<uint64_t>(std::llround(seconds * 1000000.0));
	if (timestamp > kSafeInteger) {
		Invalidate(Reason::TimestampOutOfRange);
		return;
	}
	const uint32_t size = count.load();
	if (size && timestamp <= endUs.load()) {
		Invalidate(Reason::NonIncreasingClock);
		return;
	}
	if (size == kCapacity) {
		Invalidate(Reason::Capacity);
		return;
	}
	timestamps[size].store(timestamp);
	if (!size)
		startUs.store(timestamp);
	endUs.store(timestamp);
	count.store(size + 1);
}
}

void ContextChanged() {
	uint64_t epoch = contextEpoch.load();
	// Saturate at an explicit exhausted sentinel rather than wrapping a context
	// identity and accidentally making an old capture appear valid again.
	while (epoch <= kMaxContext && !contextEpoch.compare_exchange_weak(epoch, epoch + 1)) {}
}

void Submit(double seconds) {
	const uint32_t request = pendingRequest.load(std::memory_order_acquire);
	if (!request && state.load() != State::Recording)
		return;
	sequence.fetch_add(1);
	if ((request & 3) == 1) {
		captureId.store(request >> 2);
		count.store(0);
		startUs.store(0);
		endUs.store(0);
		captureEpoch.store(contextEpoch.load());
		reason.store(Reason::None);
		state.store(State::Recording);
	}
	if (state.load() == State::Recording) {
		const Reason contextFailure = ContextReason();
		if (contextFailure != Reason::None)
			Invalidate(contextFailure);
		else
			Append(seconds);
	}
	if ((request & 3) == 2) {
		if (state.load() == State::Recording)
			state.store(State::Completed);
		else if (state.load() == State::Idle)
			Invalidate(Reason::NoActiveCapture);
	}
	if (request)
		acknowledgedId.store(request >> 2);
	sequence.fetch_add(1);
	if (request)
		pendingRequest.store(0, std::memory_order_release);
}
}

extern "C" FRAME_TIMING_EXPORT int ppssppRequestFrameTiming(int command) {
	using namespace WasmFrameTiming;
	if ((command != 1 && command != 2) || pendingRequest.load(std::memory_order_acquire) || contextEpoch.load() > kMaxContext)
		return 0;
	uint32_t id = nextRequestId.load(std::memory_order_relaxed);
	do {
		if (id > kMaxRequests)
			return 0;
	} while (!nextRequestId.compare_exchange_weak(id, id + 1, std::memory_order_relaxed));
	uint32_t empty = 0;
	return pendingRequest.compare_exchange_strong(empty, (id << 2) | static_cast<uint32_t>(command),
		std::memory_order_release, std::memory_order_relaxed) ? static_cast<int>(id) : 0;
}

extern "C" FRAME_TIMING_EXPORT double ppssppGetFrameTimingMetric(int slot) {
	using namespace WasmFrameTiming;
	if (slot == 0) return 1;
	if (slot == 1) {
		// Only Submit writes the payload sequence. Context notifications change a
		// separate monotonic even component, so concurrent rebuilds are detected
		// without turning the single-writer publication into a multi-writer lock.
		// At most kMaxRequests captures of kCapacity+1 submissions, plus bounded
		// context notifications, keep this token below JavaScript's 2^53 limit.
		return static_cast<double>(sequence.load() + 2 * contextEpoch.load());
	}
	if (slot == 2) return static_cast<uint32_t>(ContextReason() == Reason::None ? state.load() : State::Invalid);
	if (slot == 3) return captureId.load();
	if (slot == 4) return acknowledgedId.load();
	if (slot == 5) {
		const Reason contextFailure = ContextReason();
		return static_cast<uint32_t>(contextFailure == Reason::None ? reason.load() : contextFailure);
	}
	if (slot == 6) return count.load();
	if (slot == 7) return kCapacity;
	if (slot == 8) return static_cast<double>(startUs.load());
	if (slot == 9) return static_cast<double>(endUs.load());
	if (slot == 10) return static_cast<double>(captureEpoch.load());
	if (slot == 11) return static_cast<double>(contextEpoch.load());
	if (slot >= kTimestampBase && slot < kTimestampBase + static_cast<int>(kCapacity)) {
		const uint32_t index = slot - kTimestampBase;
		return index < count.load() ? static_cast<double>(timestamps[index].load()) : -1;
	}
	return -1;
}
#endif
