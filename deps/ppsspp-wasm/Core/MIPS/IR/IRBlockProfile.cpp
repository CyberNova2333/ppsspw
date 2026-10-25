#include "Core/MIPS/IR/IRBlockProfile.h"

#include <algorithm>
#include <array>
#include <atomic>
#include <cstddef>
#include <utility>

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#define IR_PROFILE_EXPORT EMSCRIPTEN_KEEPALIVE
#else
#define IR_PROFILE_EXPORT
#endif

// The test runner lowers these limits when compiling this same implementation.
#ifndef PPSSPP_WASM_IR_PROFILE_MAX_BLOCKS
#define PPSSPP_WASM_IR_PROFILE_MAX_BLOCKS 65536
#endif
#ifndef PPSSPP_WASM_IR_PROFILE_MAX_INSTRUCTIONS
#define PPSSPP_WASM_IR_PROFILE_MAX_INSTRUCTIONS 1048576
#endif
#ifndef PPSSPP_WASM_IR_PROFILE_MAX_COUNTER
#define PPSSPP_WASM_IR_PROFILE_MAX_COUNTER 9007199254740991ULL
#endif

namespace WasmIRBlockProfile {
namespace {
constexpr size_t kMaxBlocks = PPSSPP_WASM_IR_PROFILE_MAX_BLOCKS;
constexpr size_t kMaxInstructions = PPSSPP_WASM_IR_PROFILE_MAX_INSTRUCTIONS;
constexpr uint64_t kMaxCounter = PPSSPP_WASM_IR_PROFILE_MAX_COUNTER;
static_assert(kMaxCounter > 0 && kMaxCounter <= 9007199254740991ULL, "Counters must export exactly to JavaScript");
static_assert(std::atomic<double>::is_always_lock_free, "Diagnostic reads must not block the browser");
static_assert(std::atomic<uint32_t>::is_always_lock_free, "Diagnostic requests must not block the browser");

struct Block {
	uint32_t offset;
	uint32_t address;
	uint64_t entries = 0;
	std::vector<Instruction> instructions;
};

// Producer-owned registration and capture state. No getter reads these values.
std::vector<Block> blocks;
size_t instructionCount = 0;
uint64_t droppedBlocks = 0;
uint64_t cacheEpoch = 0;
bool badRegistration = false;
State state = State::Idle;
Reason reason = Reason::None;
uint32_t captureId = 0;
uint32_t acknowledgedId = 0;
uint64_t startEpoch = 0;
uint64_t endEpoch = 0;
uint64_t startUs = 0;
uint64_t endUs = 0;
uint64_t lastFrameUs = 0;
bool hasFrame = false;
uint64_t totalEntries = 0;
uint64_t touchedBlocks = 0;
uint64_t unknownEntries = 0;
bool overflow = false;
bool publishPending = false;
bool frozen = false;
std::array<double, kMetricCount> staged{};

// A sequence check alone does not make ordinary payload reads race-free.
// Sequentially consistent atomic payloads follow the performance bridge model.
std::array<std::atomic<double>, kMetricCount> published{};
std::atomic<uint32_t> sequence{};
std::atomic<uint32_t> pendingRequest{};  // request ID << 2 | command
std::atomic<uint32_t> nextRequestId{1};

bool Add(uint64_t &value, uint64_t amount) {
	if (amount > kMaxCounter - value) {
		value = kMaxCounter;
		overflow = true;
		return false;
	}
	value += amount;
	return true;
}

auto Find(uint32_t offset) {
	return std::lower_bound(blocks.begin(), blocks.end(), offset,
		[](const Block &block, uint32_t value) { return block.offset < value; });
}

// This is intentionally outside the block-entry hot path. Static instructions
// after conditional exits still contribute: these are weighted static counts.
void Freeze() {
	staged.fill(0);
	endEpoch = cacheEpoch;
	std::array<uint64_t, kOpcodeCount> histogram{};
	std::vector<const Block *> top;
	top.reserve(kMaxRows + 1);
	uint64_t weightedOps = 0;
	for (const Block &block : blocks) {
		if (!block.entries)
			continue;
		for (const Instruction &instruction : block.instructions) {
			Add(histogram[instruction.word & 255], block.entries);
			Add(weightedOps, block.entries);
		}
		auto position = std::lower_bound(top.begin(), top.end(), &block,
			[](const Block *a, const Block *b) {
				return a->entries != b->entries ? a->entries > b->entries : a->offset < b->offset;
			});
		top.insert(position, &block);
		if (top.size() > kMaxRows)
			top.pop_back();
	}
	if (overflow) {
		state = State::Invalid;
		reason = Reason::CounterOverflow;
	}
	staged[9] = static_cast<double>(totalEntries);
	staged[10] = static_cast<double>(touchedBlocks);
	staged[11] = static_cast<double>(blocks.size());
	staged[12] = static_cast<double>(droppedBlocks);
	staged[13] = static_cast<double>(top.size());
	staged[14] = static_cast<double>(weightedOps);
	staged[15] = kMaxExportOps;
	staged[16] = kMaxRows;
	staged[19] = static_cast<double>(unknownEntries);
	staged[20] = overflow ? 1 : 0;
	for (int op = 0; op < kOpcodeCount; ++op)
		staged[kHistogramBase + op] = static_cast<double>(histogram[op]);
	for (size_t row = 0; row < top.size(); ++row) {
		const Block &block = *top[row];
		const size_t storedOps = std::min(block.instructions.size(), static_cast<size_t>(kMaxExportOps));
		const size_t base = kRowsBase + row * kRowStride;
		staged[base] = block.offset;
		staged[base + 1] = block.address;
		staged[base + 2] = static_cast<double>(block.entries);
		staged[base + 3] = static_cast<double>(block.instructions.size());
		staged[base + 4] = static_cast<double>(storedOps);
		staged[base + 5] = storedOps < block.instructions.size() ? 1 : 0;
		staged[17] += staged[base + 5];
		for (size_t index = 0; index < storedOps; ++index) {
			staged[base + 6 + 2 * index] = block.instructions[index].word;
			staged[base + 7 + 2 * index] = block.instructions[index].constant;
		}
	}
	frozen = true;
	publishPending = true;
}

void Invalidate(Reason why) {
	if (state != State::Recording)
		return;
	state = State::Invalid;
	reason = why;
	Freeze();
}

void Publish() {
	staged[0] = 1;
	staged[2] = static_cast<uint32_t>(state);
	staged[3] = static_cast<uint32_t>(reason);
	staged[4] = acknowledgedId;
	staged[5] = captureId;
	staged[6] = static_cast<double>(endEpoch);
	staged[7] = static_cast<double>(startUs);
	staged[8] = static_cast<double>(endUs);
	staged[18] = static_cast<double>(startEpoch);
	sequence.fetch_add(1);
	for (int slot = 0; slot < kMetricCount; ++slot) {
		if (slot != 1)
			published[slot].store(staged[slot]);
	}
	sequence.fetch_add(1);
	publishPending = false;
}

void Start(uint32_t id, uint64_t emulatedUs, bool emulating) {
	captureId = id;
	startEpoch = cacheEpoch;
	startUs = endUs = emulatedUs;
	totalEntries = touchedBlocks = unknownEntries = 0;
	overflow = false;
	frozen = false;
	state = State::Recording;
	reason = Reason::None;
	for (Block &block : blocks)
		block.entries = 0;
	if (!emulating)
		Invalidate(Reason::NotEmulating);
	else if (badRegistration)
		Invalidate(Reason::InvalidRegistration);
	else if (droppedBlocks)
		Invalidate(Reason::RegistrationBudget);
	else {
		Freeze();
		frozen = false;  // Publish the start ACK without freezing the new capture.
	}
}
}

void RegisterBlock(uint32_t offset, uint32_t address, std::vector<Instruction> instructions) {
	auto position = Find(offset);
	if (instructions.empty() || (position != blocks.end() && position->offset == offset)) {
		badRegistration = true;
		Invalidate(Reason::InvalidRegistration);
		return;
	}
	if (blocks.size() >= kMaxBlocks || instructions.size() > kMaxInstructions - instructionCount) {
		if (droppedBlocks < kMaxCounter)
			++droppedBlocks;
		Invalidate(Reason::RegistrationBudget);
		return;
	}
	instructionCount += instructions.size();
	blocks.insert(position, Block{offset, address, 0, std::move(instructions)});
}

void EnterBlock(uint32_t offset) {
	if (state != State::Recording)
		return;
	if (!Add(totalEntries, 1)) {
		Invalidate(Reason::CounterOverflow);
		return;
	}
	auto position = Find(offset);
	if (position == blocks.end() || position->offset != offset) {
		Add(unknownEntries, 1);
		Invalidate(Reason::UnknownOffset);
		return;
	}
	if (!position->entries)
		++touchedBlocks;
	if (!Add(position->entries, 1))
		Invalidate(Reason::CounterOverflow);
}

void ClearCache() {
	// Freeze while old static IR still exists. Frame publishes after updating the
	// time and epoch; a previously completed snapshot remains unchanged.
	const bool wasRecording = state == State::Recording;
	Invalidate(Reason::CacheCleared);
	blocks.clear();
	instructionCount = 0;
	droppedBlocks = 0;
	badRegistration = false;
	++cacheEpoch;
	if (wasRecording)
		endEpoch = cacheEpoch;
}

void Frame(uint64_t emulatedUs, bool emulating) {
	if (state == State::Recording) {
		if (!emulating)
			Invalidate(Reason::NotEmulating);
		else if (hasFrame && emulatedUs < lastFrameUs)
			Invalidate(Reason::EmulatedTimeReversed);
	}
	if (publishPending && frozen)
		endUs = emulatedUs;
	lastFrameUs = emulatedUs;
	hasFrame = true;
	const uint32_t request = pendingRequest.load(std::memory_order_acquire);
	if (request) {
		acknowledgedId = request >> 2;
		if ((request & 3) == 1) {
			Start(acknowledgedId, emulatedUs, emulating);
		} else if (state == State::Recording) {
			state = State::Completed;
			endUs = emulatedUs;
			Freeze();
		} else {
			if (state == State::Idle) {
				state = State::Invalid;
				reason = Reason::NoActiveCapture;
				startUs = endUs = emulatedUs;
				startEpoch = cacheEpoch;
				Freeze();
			}
			publishPending = true;  // A repeated stop acknowledges the frozen result.
		}
	}
	if (publishPending)
		Publish();
	if (request)
		pendingRequest.store(0, std::memory_order_release);
}
}

extern "C" IR_PROFILE_EXPORT int ppssppRequestIRBlockProfile(int command) {
	using namespace WasmIRBlockProfile;
	if ((command != 1 && command != 2) || pendingRequest.load(std::memory_order_acquire))
		return 0;
	uint32_t id = nextRequestId.load(std::memory_order_relaxed);
	do {
		if (id > 0x3fffffff)
			return 0;
	} while (!nextRequestId.compare_exchange_weak(id, id + 1, std::memory_order_relaxed));
	uint32_t empty = 0;
	return pendingRequest.compare_exchange_strong(empty, (id << 2) | static_cast<uint32_t>(command),
		std::memory_order_release, std::memory_order_relaxed) ? static_cast<int>(id) : 0;
}

extern "C" IR_PROFILE_EXPORT double ppssppGetIRBlockProfileMetric(int slot) {
	using namespace WasmIRBlockProfile;
	if (slot < 0 || slot >= kMetricCount)
		return -1;
	if (slot == 0)
		return 1;
	if (slot == 1)
		return sequence.load();
	return published[slot].load();
}
