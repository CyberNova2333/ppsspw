#include "Core/MIPS/IR/IRBlockProfile.h"

#include <array>
#include <atomic>
#include <cassert>
#include <cstdint>
#include <cstdio>
#include <thread>
#include <vector>

using namespace WasmIRBlockProfile;
using Snapshot = std::array<double, kMetricCount>;

static Snapshot Read() {
	for (int attempt = 0; attempt < 100000; ++attempt) {
		Snapshot result{};
		const double sequence = ppssppGetIRBlockProfileMetric(1);
		if (static_cast<uint32_t>(sequence) & 1)
			continue;
		for (int slot = 0; slot < kMetricCount; ++slot)
			result[slot] = ppssppGetIRBlockProfileMetric(slot);
		if (sequence == ppssppGetIRBlockProfileMetric(1))
			return result;
	}
	assert(false && "A coherent snapshot must eventually be published");
	return {};
}

static int Start(uint64_t time = 1000) {
	const int request = ppssppRequestIRBlockProfile(1);
	assert(request > 0);
	assert(ppssppRequestIRBlockProfile(2) == 0);
	Frame(time, true);
	const auto snapshot = Read();
	assert(snapshot[4] == request && snapshot[5] == request);
	return request;
}

static Snapshot Stop(uint64_t time = 2000) {
	const int request = ppssppRequestIRBlockProfile(2);
	assert(request > 0);
	Frame(time, true);
	auto snapshot = Read();
	assert(snapshot[4] == request);
	return snapshot;
}

static void ExpectInvalid(const Snapshot &snapshot, Reason why) {
	assert(snapshot[2] == static_cast<uint32_t>(State::Invalid));
	assert(snapshot[3] == static_cast<uint32_t>(why));
}

static std::vector<Instruction> Ops(size_t count, uint8_t op = 7) {
	std::vector<Instruction> result(count);
	for (size_t index = 0; index < count; ++index)
		result[index] = {static_cast<uint32_t>(op) | (0x030201u << 8), static_cast<uint32_t>(index)};
	return result;
}

static void TestInitialStop() {
	assert(ppssppGetIRBlockProfileMetric(0) == 1);
	assert(ppssppGetIRBlockProfileMetric(1) == 0);
	const auto snapshot = Stop(100);
	ExpectInvalid(snapshot, Reason::NoActiveCapture);
	assert(snapshot[5] == 0 && snapshot[9] == 0);
	const int start = ppssppRequestIRBlockProfile(1);
	assert(start > 0);
	Frame(200, false);
	ExpectInvalid(Read(), Reason::NotEmulating);
}

static void TestRegistrationGrowthAndStaticWeighting() {
	ClearCache();
	// Reverse registration exercises sorted insertion and lookup across vector
	// reallocations. No stored pointer is retained across RegisterBlock calls.
	for (uint32_t index = 96; index > 0; --index)
		RegisterBlock(index * 8, 0x1000 + index * 4, Ops(1));
	const int capture = Start();
	for (uint32_t index = 1; index <= 96; ++index) {
		EnterBlock(index * 8);
		if (index <= 3)
			EnterBlock(index * 8);
	}
	auto snapshot = Stop();
	assert(snapshot[2] == static_cast<uint32_t>(State::Completed));
	assert(snapshot[5] == capture && snapshot[7] == 1000 && snapshot[8] == 2000);
	assert(snapshot[9] == 99 && snapshot[10] == 96 && snapshot[11] == 96);
	assert(snapshot[13] == kMaxRows && snapshot[14] == 99);
	assert(snapshot[kHistogramBase + 7] == 99);
	assert(snapshot[kRowsBase] == 8 && snapshot[kRowsBase + 2] == 2);
	assert(snapshot[kRowsBase + kRowStride] == 16);
	assert(snapshot[kRowsBase + 3 * kRowStride] == 32);
	// A new capture resets entries, retaining static registration.
	Start(3000);
	EnterBlock(8);
	snapshot = Stop(4000);
	assert(snapshot[9] == 1 && snapshot[10] == 1 && snapshot[11] == 96);

	ClearCache();
	// This is a static block containing an arbitrary exit-like op followed by
	// another op. Entry counting includes both, even if a real exit takes early.
	RegisterBlock(4, 0x2000, {{1, 20}, {2, 40}, {1, 60}, {3, 80}});
	Start();
	EnterBlock(4);
	EnterBlock(4);
	snapshot = Stop();
	assert(snapshot[14] == 8);
	assert(snapshot[kHistogramBase + 1] == 4);
	assert(snapshot[kHistogramBase + 2] == 2 && snapshot[kHistogramBase + 3] == 2);
	assert(snapshot[kRowsBase + 6] == 1 && snapshot[kRowsBase + 7] == 20);
}

static void TestTruncationAndFrozenMetadata() {
	ClearCache();
	RegisterBlock(10, 0x12345678, Ops(kMaxExportOps + 1, 9));
	Start();
	EnterBlock(10);
	EnterBlock(10);
	const auto before = Stop();
	assert(before[14] == 2 * (kMaxExportOps + 1));
	assert(before[kHistogramBase + 9] == 2 * (kMaxExportOps + 1));
	assert(before[17] == 1 && before[kRowsBase + 3] == kMaxExportOps + 1);
	assert(before[kRowsBase + 4] == kMaxExportOps && before[kRowsBase + 5] == 1);
	assert(before[kRowsBase + 6] == (9u | (0x030201u << 8)));
	assert(before[kRowsBase + 7 + 2 * (kMaxExportOps - 1)] == kMaxExportOps - 1);
	ClearCache();
	RegisterBlock(10, 0x87654321, Ops(2, 10));
	Frame(3000, true);
	const auto preserved = Read();
	assert(preserved == before);
	const auto repeated = Stop(4000);
	assert(repeated[6] == before[6] && repeated[8] == before[8]);
	assert(repeated[kRowsBase + 1] == 0x12345678);
	Start(5000);
	EnterBlock(10);
	const auto current = Stop(6000);
	assert(current[6] > before[6] && current[kRowsBase + 1] == 0x87654321);
}

static void TestInvalidationAndRequests() {
	assert(ppssppRequestIRBlockProfile(0) == 0);
	assert(ppssppRequestIRBlockProfile(3) == 0);
	assert(ppssppGetIRBlockProfileMetric(-1) == -1);
	assert(ppssppGetIRBlockProfileMetric(kMetricCount) == -1);
	ClearCache();
	RegisterBlock(4, 0x1000, Ops(2));
	Start();
	EnterBlock(4);
	ClearCache();
	RegisterBlock(4, 0x2000, Ops(3));
	EnterBlock(4);  // Invalidated captures never resume in a new cache epoch.
	Frame(1500, true);
	auto snapshot = Read();
	ExpectInvalid(snapshot, Reason::CacheCleared);
	assert(snapshot[9] == 1 && snapshot[14] == 2);
	assert(snapshot[6] > snapshot[18]);
	assert(snapshot[kRowsBase + 1] == 0x1000 && snapshot[8] == 1500);

	Start(2000);
	Frame(2100, false);
	ExpectInvalid(Read(), Reason::NotEmulating);
	Start(3000);
	Frame(2999, true);
	ExpectInvalid(Read(), Reason::EmulatedTimeReversed);
	Start(4000);
	EnterBlock(99);
	Frame(4100, true);
	snapshot = Read();
	ExpectInvalid(snapshot, Reason::UnknownOffset);
	assert(snapshot[9] == 1 && snapshot[19] == 1);

	ClearCache();
	RegisterBlock(1, 0, Ops(1));
	Start();
	RegisterBlock(1, 4, Ops(1));
	Frame(1100, true);
	ExpectInvalid(Read(), Reason::InvalidRegistration);
	Start(1200);
	ExpectInvalid(Read(), Reason::InvalidRegistration);
}

static void TestBudgetsAndOverflow() {
	ClearCache();
	for (uint32_t index = 0; index < PPSSPP_WASM_IR_PROFILE_MAX_BLOCKS; ++index)
		RegisterBlock(index, index * 4, Ops(1));
	Start();
	RegisterBlock(PPSSPP_WASM_IR_PROFILE_MAX_BLOCKS, 0, Ops(1));
	Frame(1500, true);
	auto snapshot = Read();
	ExpectInvalid(snapshot, Reason::RegistrationBudget);
	assert(snapshot[12] == 1);
	Start(2000);
	ExpectInvalid(Read(), Reason::RegistrationBudget);

	ClearCache();
	RegisterBlock(1, 0, Ops(PPSSPP_WASM_IR_PROFILE_MAX_INSTRUCTIONS));
	RegisterBlock(2, 4, Ops(1));
	Start();
	ExpectInvalid(Read(), Reason::RegistrationBudget);
	ClearCache();
	RegisterBlock(1, 0, Ops(1));
	Start();
	for (uint64_t index = 0; index <= PPSSPP_WASM_IR_PROFILE_MAX_COUNTER; ++index)
		EnterBlock(1);
	Frame(1500, true);
	snapshot = Read();
	ExpectInvalid(snapshot, Reason::CounterOverflow);
	assert(snapshot[9] == PPSSPP_WASM_IR_PROFILE_MAX_COUNTER && snapshot[20] == 1);

	// Entry counts can fit while the weighted static total overflows.
	ClearCache();
	RegisterBlock(1, 0, Ops(2));
	Start();
	for (uint64_t index = 0; index <= PPSSPP_WASM_IR_PROFILE_MAX_COUNTER / 2; ++index)
		EnterBlock(1);
	snapshot = Stop();
	ExpectInvalid(snapshot, Reason::CounterOverflow);
	assert(snapshot[14] == PPSSPP_WASM_IR_PROFILE_MAX_COUNTER && snapshot[20] == 1);
}

static void TestConcurrentPublication() {
	ClearCache();
	RegisterBlock(1, 0x1000, Ops(2, 11));
	Start();
	Stop();
	std::atomic<bool> done{false};
	std::atomic<int> reads{0};
	std::thread reader([&] {
		while (!done.load(std::memory_order_acquire)) {
			const auto snapshot = Read();
			assert(snapshot[0] == 1 && static_cast<uint32_t>(snapshot[1]) % 2 == 0);
			assert(snapshot[3] == 0 && snapshot[11] == 1);
			assert(snapshot[14] == 2 * snapshot[9]);
			assert(snapshot[kHistogramBase + 11] == snapshot[14]);
			assert(snapshot[13] == (snapshot[9] > 0 ? 1 : 0));
			++reads;
		}
	});
	for (uint64_t run = 1; run <= 100; ++run) {
		const uint64_t start = 3000 + run * 1000;
		Start(start);
		for (uint64_t entry = 0; entry < run; ++entry)
			EnterBlock(1);
		Stop(start + 500);
	}
	done.store(true, std::memory_order_release);
	reader.join();
	assert(reads.load() > 0);
}

static void TestConcurrentRequests() {
	ClearCache();
	RegisterBlock(1, 0x1000, Ops(1));
	Start();
	std::atomic<int> ready{0};
	std::atomic<bool> issue{false};
	int ids[2]{};
	auto request = [&](int index) {
		++ready;
		while (!issue.load(std::memory_order_acquire))
			std::this_thread::yield();
		ids[index] = ppssppRequestIRBlockProfile(index + 1);
	};
	std::thread first(request, 0), second(request, 1);
	while (ready.load() != 2)
		std::this_thread::yield();
	issue.store(true, std::memory_order_release);
	first.join();
	second.join();
	assert((ids[0] > 0) != (ids[1] > 0));
	Frame(1500, true);
	assert(Read()[4] == (ids[0] ? ids[0] : ids[1]));
}

int main() {
	TestInitialStop();
	TestRegistrationGrowthAndStaticWeighting();
	TestTruncationAndFrozenMetadata();
	TestInvalidationAndRequests();
	TestBudgetsAndOverflow();
	TestConcurrentPublication();
	TestConcurrentRequests();
	std::puts("IR block profile: registration, requests, static weighting, lifecycle, bounds and atomic snapshots passed");
}
