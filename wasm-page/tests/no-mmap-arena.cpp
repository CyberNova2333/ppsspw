// Exercise production arena ownership without reserving a real 160 MiB block.
#include <cassert>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <type_traits>

#include "Common/MemArena.h"

static_assert(!std::is_copy_constructible_v<MemArena>);
static_assert(!std::is_copy_assignable_v<MemArena>);

namespace {
constexpr size_t arenaBytes = 0x0A000000;
constexpr size_t ramBytes = 32 * 1024 * 1024;
alignas(std::max_align_t) unsigned char slots[32][64];
bool live[32]{};
size_t attempts = 0;
size_t allocations = 0;
size_t releases = 0;
size_t outstanding = 0;
bool failNext = false;
}

extern "C" void *__real_malloc(size_t size);
extern "C" void __real_free(void *pointer);

extern "C" void *__wrap_malloc(size_t size) {
	if (size != arenaBytes)
		return __real_malloc(size);
	++attempts;
	if (failNext) {
		failNext = false;
		return nullptr;
	}
	const size_t slot = allocations++;
	assert(slot < 32 && !live[slot]);
	live[slot] = true;
	++outstanding;
	return slots[slot];
}

extern "C" void __wrap_free(void *pointer) {
	for (size_t slot = 0; slot < 32; ++slot) {
		if (pointer == slots[slot]) {
			assert(live[slot]);
			live[slot] = false;
			++releases;
			--outstanding;
			return;
		}
	}
	__real_free(pointer);
}

int main() {
	MemArena arena;
	arena.ReleaseSpace();
	assert(releases == 0);
	for (int cycle = 0; cycle < 4; ++cycle) {
		assert(arena.GrabMemSpace(ramBytes));
		const size_t previousAttempts = attempts;
		const size_t previousReleases = releases;
		u8 *base = arena.Find4GBBase();
		assert(base != nullptr && outstanding == 1);
		// A repeated setup query must keep its owner and not leak a second block.
		assert(arena.Find4GBBase() == base);
		assert(attempts == previousAttempts + 1);
		void *view = arena.CreateView(0, ramBytes, base);
		assert(view == base);
		void *alias = arena.CreateView(0, ramBytes, base);
		assert(alias == view);
		arena.ReleaseView(0, view, ramBytes);
		arena.ReleaseView(0, alias, ramBytes);
		assert(releases == previousReleases && outstanding == 1);
		arena.ReleaseSpace();
		assert(releases == previousReleases + 1 && outstanding == 0);
		arena.ReleaseSpace();
		assert(releases == previousReleases + 1);
	}
	// A failed allocation creates no owner and does not prevent a later retry.
	failNext = true;
	assert(arena.Find4GBBase() == nullptr);
	assert(outstanding == 0);
	arena.ReleaseSpace();
	assert(arena.Find4GBBase() != nullptr);
	assert(outstanding == 1);
	arena.ReleaseSpace();
	assert(outstanding == 0);
	// Owners belong to individual arena instances, not a process-global pointer.
	MemArena other;
	u8 *first = arena.Find4GBBase();
	u8 *second = other.Find4GBBase();
	assert(first && second && first != second && outstanding == 2);
	arena.ReleaseSpace();
	assert(outstanding == 1 && other.Find4GBBase() == second);
	other.ReleaseSpace();
	assert(outstanding == 0 && allocations == releases);
	std::printf("NO_MMAP arena ownership passed: %zu allocations, %zu releases, zero outstanding\n", allocations, releases);
}
