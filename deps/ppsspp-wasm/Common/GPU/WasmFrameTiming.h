#pragma once

#include <cstdint>

// Diagnostic builds only. Submit has one serialized render-thread producer.
// Browser requests and reads, and context notifications, only access atomics.
namespace WasmFrameTiming {
enum class State : uint32_t { Idle, Recording, Completed, Invalid };
enum class Reason : uint32_t {
	None, NonIncreasingClock, Capacity, ContextChanged, NoActiveCapture,
	TimestampOutOfRange, CounterExhausted,
};

constexpr int kTimestampBase = 32;

// Called immediately after the CPU-side swap callback returns. This does not
// observe GPU completion or the browser compositor's physical presentation.
void Submit(double seconds);
// Manager construction/destruction and device-object ThreadStart/ThreadEnd.
// Browser context-loss events must also be rejected by the page collector.
void ContextChanged();
}

// 1 starts, 2 stops. A positive ID must be acknowledged at a swap boundary;
// 0 means invalid command, another pending request, or exhausted request IDs.
extern "C" int ppssppRequestFrameTiming(int command);

// Read between two equal even slot-1 tokens. All returned integers are exact
// JavaScript safe integers. Slots: 0 schema, 1 token, 2 state, 3 capture ID,
// 4 acknowledged request ID, 5 reason, 6 count, 7 capacity, 8 start us, 9 end us,
// 10 capture context epoch, 11 current context epoch, 32+i timestamp us.
// Reserved, unwritten and invalid slots return -1. Export full timestamp data
// only after a matching stop acknowledgement and Completed state.
extern "C" double ppssppGetFrameTimingMetric(int slot);
