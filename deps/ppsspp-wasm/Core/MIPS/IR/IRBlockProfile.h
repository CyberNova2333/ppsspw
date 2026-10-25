#pragma once

#include <cstdint>
#include <vector>

// Diagnostic builds only. All producer calls below must be serialized by the
// caller. The browser ABI at the bottom only touches atomics and may run on a
// different thread. Nothing in this module reaches into a live JIT or its cache.
namespace WasmIRBlockProfile {
struct Instruction {
	uint32_t word;  // op | dest << 8 | src1 << 16 | src2 << 24
	uint32_t constant;
};

enum class State : uint32_t { Idle, Recording, Completed, Invalid };
enum class Reason : uint32_t {
	None, CacheCleared, NotEmulating, EmulatedTimeReversed, RegistrationBudget,
	UnknownOffset, CounterOverflow, InvalidRegistration, NoActiveCapture,
};

constexpr int kHistogramBase = 32;
constexpr int kOpcodeCount = 256;
constexpr int kRowsBase = kHistogramBase + kOpcodeCount;
constexpr int kMaxRows = 32;
constexpr int kMaxExportOps = 128;
constexpr int kRowStride = 6 + 2 * kMaxExportOps;
constexpr int kMetricCount = kRowsBase + kMaxRows * kRowStride;

void RegisterBlock(uint32_t offset, uint32_t address, std::vector<Instruction> instructions);
void EnterBlock(uint32_t offset);
void ClearCache();
void Frame(uint64_t emulatedUs, bool emulating);
}

// command: 1 starts a new capture; 2 freezes the active capture. Returns a
// positive request ID, or 0 for an invalid command, a pending request, or ID
// exhaustion. Wait for metric 4 to acknowledge the returned ID.
extern "C" int ppssppRequestIRBlockProfile(int command);
// Slot 0 is schema 1, slot 1 is the publication sequence. Read all desired slots
// between two equal even sequences. An invalid slot returns -1. Opcode totals
// are block entries times static opcode occurrences, NOT executed opcode counts.
extern "C" double ppssppGetIRBlockProfileMetric(int slot);
