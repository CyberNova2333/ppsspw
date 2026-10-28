#include "Common/GPU/WasmFrameTiming.h"

#include <array>
#include <atomic>
#include <cassert>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <limits>
#include <thread>
#include <vector>

using namespace WasmFrameTiming;
constexpr int kTestCapacity = 8;
using Snapshot = std::array<double, kTimestampBase + kTestCapacity>;

static Snapshot Read() {
	for (int attempt = 0; attempt < 100000; ++attempt) {
		Snapshot result{};
		const double token = ppssppGetFrameTimingMetric(1);
		if (static_cast<uint64_t>(token) & 1)
			continue;
		for (int slot = 0; slot < static_cast<int>(result.size()); ++slot)
			result[slot] = ppssppGetFrameTimingMetric(slot);
		if (token == ppssppGetFrameTimingMetric(1))
			return result;
	}
	assert(false && "A coherent snapshot must eventually be published");
	return {};
}

static void Invalid(const Snapshot &snapshot, Reason why) {
	assert(snapshot[2] == static_cast<uint32_t>(State::Invalid));
	assert(snapshot[5] == static_cast<uint32_t>(why));
}

static int Start(double seconds = 1.0) {
	const int request = ppssppRequestFrameTiming(1);
	assert(request > 0);
	assert(ppssppRequestFrameTiming(2) == 0);
	Submit(seconds);
	const auto snapshot = Read();
	assert(snapshot[3] == request && snapshot[4] == request);
	return request;
}

static Snapshot Stop(double seconds = 2.0) {
	const int request = ppssppRequestFrameTiming(2);
	assert(request > 0);
	Submit(seconds);
	const auto snapshot = Read();
	assert(snapshot[4] == request);
	return snapshot;
}

static void ValidateCompleted(const Snapshot &snapshot) {
	assert(snapshot[2] == static_cast<uint32_t>(State::Completed));
	assert(snapshot[3] > 0 && snapshot[5] == 0);
	const int count = static_cast<int>(snapshot[6]);
	assert(count >= 2 && count <= kTestCapacity);
	assert(snapshot[8] == snapshot[kTimestampBase]);
	assert(snapshot[9] == snapshot[kTimestampBase + count - 1]);
	for (int index = 1; index < count; ++index)
		assert(snapshot[kTimestampBase + index] > snapshot[kTimestampBase + index - 1]);
	for (int index = count; index < kTestCapacity; ++index)
		assert(snapshot[kTimestampBase + index] == -1);
}

static void TestRequestsAndBoundaries() {
	assert(ppssppGetFrameTimingMetric(0) == 1);
	assert(ppssppGetFrameTimingMetric(1) == 0);
	assert(ppssppGetFrameTimingMetric(2) == static_cast<uint32_t>(State::Idle));
	assert(ppssppGetFrameTimingMetric(7) == kTestCapacity);
	assert(ppssppRequestFrameTiming(0) == 0 && ppssppRequestFrameTiming(3) == 0);
	assert(ppssppGetFrameTimingMetric(-1) == -1);
	assert(ppssppGetFrameTimingMetric(12) == -1);
	assert(ppssppGetFrameTimingMetric(31) == -1);
	assert(ppssppGetFrameTimingMetric(kTimestampBase + kTestCapacity) == -1);
	ContextChanged();
	const int idleStop = ppssppRequestFrameTiming(2);
	assert(idleStop > 0 && ppssppGetFrameTimingMetric(4) == 0);
	Submit(0.0);
	Invalid(Read(), Reason::NoActiveCapture);
	assert(Read()[3] == 0 && Read()[6] == 0);

	const int capture = Start(0.0);
	assert(Read()[6] == 1 && Read()[8] == 0);
	Submit(0.016667);
	Submit(0.033334);
	const int stop = ppssppRequestFrameTiming(2);
	assert(stop > capture && Read()[4] == capture);
	assert(Read()[2] == static_cast<uint32_t>(State::Recording));
	Submit(0.050001);
	const auto frozen = Read();
	ValidateCompleted(frozen);
	assert(frozen[4] == stop && frozen[6] == 4);
	assert(frozen[9] == 50001);
	const double token = frozen[1];
	Submit(7.0);
	assert(Read() == frozen && Read()[1] == token);
	const auto repeatedStop = Stop(8.0);
	assert(repeatedStop[3] == capture && repeatedStop[6] == 4);
	for (int index = 0; index < kTestCapacity; ++index)
		assert(repeatedStop[kTimestampBase + index] == frozen[kTimestampBase + index]);

	// A start can replace a completed or a still-recording capture; stale array
	// values are hidden by count and the publication token changes each time.
	const int replacement = Start(9.0);
	assert(replacement > stop && Read()[6] == 1);
	assert(Read()[kTimestampBase + 1] == -1);
	Start(10.0);
	assert(Read()[6] == 1 && Read()[8] == 10000000);
	ValidateCompleted(Stop(10.01));
}

static void TestInvalidClocks() {
	Start(1.0);
	Submit(1.0);
	Invalid(Read(), Reason::NonIncreasingClock);
	assert(Read()[6] == 1);
	Invalid(Stop(2.0), Reason::NonIncreasingClock);
	Start(1.0);
	Submit(0.9);
	Invalid(Read(), Reason::NonIncreasingClock);
	Start(1.0);
	Submit(1.0000001);  // rounds to the same integer microsecond
	Invalid(Read(), Reason::NonIncreasingClock);
	for (const double bad : {-1.0, std::numeric_limits<double>::infinity(),
		std::numeric_limits<double>::quiet_NaN(), 9007199255.0}) {
		Start(bad);
		Invalid(Read(), Reason::TimestampOutOfRange);
		assert(Read()[6] == 0 && Read()[8] == 0 && Read()[9] == 0);
	}
	Start(9007199254.74098);
	assert(Read()[2] == static_cast<uint32_t>(State::Recording));
	assert(Read()[8] <= 9007199254740991.0 && std::floor(Read()[8]) == Read()[8]);
	Stop(9007199254.74099);
}

static void TestCapacity() {
	Start(1.0);
	for (int index = 1; index < kTestCapacity; ++index)
		Submit(1.0 + index * 0.01);
	const auto full = Read();
	assert(full[2] == static_cast<uint32_t>(State::Recording));
	assert(full[6] == kTestCapacity);
	Submit(2.0);
	Invalid(Read(), Reason::Capacity);
	assert(Read()[6] == kTestCapacity);
	const auto overflow = Stop(3.0);
	Invalid(overflow, Reason::Capacity);
	for (int index = 0; index < kTestCapacity; ++index)
		assert(overflow[kTimestampBase + index] == full[kTimestampBase + index]);
	Start(1.0);
	for (int index = 1; index < kTestCapacity - 1; ++index)
		Submit(1.0 + index * 0.01);
	ValidateCompleted(Stop(2.0));  // terminal boundary exactly fills the array
}

static void TestContextChanges() {
	Start();
	const auto recording = Read();
	ContextChanged();
	const auto changed = Read();
	Invalid(changed, Reason::ContextChanged);
	assert(changed[1] == recording[1] + 2 && changed[10] != changed[11]);
	const auto stopped = Stop();
	Invalid(stopped, Reason::ContextChanged);
	assert(stopped[6] == recording[6]);
	Start();
	const auto completed = Stop();
	ValidateCompleted(completed);
	ContextChanged();
	Invalid(Read(), Reason::ContextChanged);
	Start();
	assert(Read()[10] == Read()[11]);
	ValidateCompleted(Stop());
}

static void TestContendedRequests() {
	std::atomic<bool> go{};
	std::array<int, 8> requests{};
	std::vector<std::thread> threads;
	for (size_t index = 0; index < requests.size(); ++index) {
		threads.emplace_back([&, index] {
			while (!go.load()) std::this_thread::yield();
			requests[index] = ppssppRequestFrameTiming(1);
		});
	}
	go.store(true);
	for (auto &thread : threads) thread.join();
	int accepted = 0, id = 0;
	for (int request : requests) {
		if (request > 0) { ++accepted; id = request; }
	}
	assert(accepted == 1);
	Submit(1.0);
	assert(Read()[3] == id && Read()[4] == id);
	ValidateCompleted(Stop());
}

static void TestConcurrentSnapshotsAndRestarts() {
	std::atomic<bool> done{};
	std::atomic<uint32_t> desired{}, processed{}, readCount{};
	std::thread producer([&] {
		uint32_t tick = 0;
		while (!done.load()) {
			if (processed.load() < desired.load()) {
				Submit(++tick * 0.001);
				processed.fetch_add(1);
			} else {
				std::this_thread::yield();
			}
		}
	});
	std::thread reader([&] {
		while (!done.load()) {
			const auto snapshot = Read();
			if (snapshot[2] == static_cast<uint32_t>(State::Completed))
				ValidateCompleted(snapshot);
			readCount.fetch_add(1);
		}
	});
	auto submit = [&](uint32_t number) {
		const uint32_t target = desired.fetch_add(number) + number;
		while (processed.load() < target) std::this_thread::yield();
	};
	for (int repeat = 0; repeat < 128; ++repeat) {
		const int start = ppssppRequestFrameTiming(1);
		assert(start > 0);
		submit(1);
		assert(Read()[3] == start && Read()[4] == start);
		submit(2);
		const int stop = ppssppRequestFrameTiming(2);
		assert(stop > 0);
		submit(1);
		const auto snapshot = Read();
		ValidateCompleted(snapshot);
		assert(snapshot[4] == stop && snapshot[6] == 4);
	}
	done.store(true);
	producer.join();
	reader.join();
	assert(readCount.load() > 0);

	// Context notification has a separate atomic writer, including while the
	// producer is publishing. Stable snapshots can never remain Completed.
	done.store(false);
	Start();
	std::thread contexts([&] {
		for (int repeat = 0; repeat < 10000; ++repeat) ContextChanged();
		done.store(true);
	});
	while (!done.load()) {
		Submit(1.1);
		const auto snapshot = Read();
		assert(snapshot[2] != static_cast<uint32_t>(State::Completed));
	}
	contexts.join();
	Invalid(Read(), Reason::ContextChanged);
	Start();
	ValidateCompleted(Stop());
}

static void TestRequestExhaustion() {
	int previous = static_cast<int>(Read()[4]);
	for (;;) {
		const int request = ppssppRequestFrameTiming(2);
		if (!request) break;
		assert(request > previous && request <= 4096);
		previous = request;
		Submit(2.0);
		assert(Read()[4] == request);
	}
	assert(previous == 4096);
	assert(ppssppRequestFrameTiming(1) == 0 && ppssppRequestFrameTiming(2) == 0);
	assert(ppssppGetFrameTimingMetric(1) < 9007199254740991.0);
}

int main() {
	TestRequestsAndBoundaries();
	TestInvalidClocks();
	TestCapacity();
	TestContextChanges();
	TestContendedRequests();
	TestConcurrentSnapshotsAndRestarts();
	TestRequestExhaustion();
	std::puts("WASM frame timing ABI: boundaries, failures, atomic snapshots and restarts passed.");
}
