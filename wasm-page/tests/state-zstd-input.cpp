#include <algorithm>
#include <cassert>
#include <cstddef>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <memory>
#include <new>
#include <string>
#include <vector>
#include <snappy-c.h>
#define ZSTD_STATIC_LINKING_ONLY
#include <zstd.h>

#include "Common/File/FileUtil.h"
#include "Common/Serialize/Serializer.h"

namespace TestFile { Data input; }

namespace {
constexpr size_t INPUT_LIMIT = 1024 * 1024;
bool observe = false;
bool mismatchVersion = false;
int rejectParameter = 0;
size_t liveArrays = 0, peakArrays = 0, maxArray = 0, arrayCount = 0;
size_t streamCalls = 0, oneShotCalls = 0, contextPeak = 0;
ZSTD_DCtx *streamContext = nullptr;
struct alignas(std::max_align_t) Allocation { size_t size; bool counted; };
}

void *operator new[](size_t size) {
    auto *allocation = static_cast<Allocation *>(std::malloc(sizeof(Allocation) + size));
    if (!allocation) throw std::bad_alloc();
    *allocation = {size, observe};
    if (observe) {
        ++arrayCount;
        liveArrays += size;
        peakArrays = std::max(peakArrays, liveArrays);
        maxArray = std::max(maxArray, size);
    }
    return allocation + 1;
}
void operator delete[](void *ptr) noexcept {
    if (!ptr) return;
    auto *allocation = static_cast<Allocation *>(ptr) - 1;
    if (allocation->counted) { liveArrays -= allocation->size; --arrayCount; }
    std::free(allocation);
}
void operator delete[](void *ptr, size_t) noexcept { operator delete[](ptr); }

extern "C" unsigned __real_ZSTD_versionNumber();
extern "C" size_t __real_ZSTD_DCtx_setParameter(ZSTD_DCtx *, ZSTD_dParameter, int);
extern "C" size_t __real_ZSTD_freeDCtx(ZSTD_DCtx *);
extern "C" size_t __real_ZSTD_decompressStream(ZSTD_DCtx *, ZSTD_outBuffer *, ZSTD_inBuffer *);
extern "C" size_t __real_ZSTD_decompress(void *, size_t, const void *, size_t);
extern "C" unsigned __wrap_ZSTD_versionNumber() {
    return __real_ZSTD_versionNumber() + (observe && mismatchVersion ? 1 : 0);
}
extern "C" size_t __wrap_ZSTD_DCtx_setParameter(ZSTD_DCtx *ctx, ZSTD_dParameter parameter, int value) {
    if (observe) streamContext = ctx;
    if (observe && (rejectParameter == 1 || (rejectParameter == 2 && parameter == ZSTD_d_windowLogMax)))
        return __real_ZSTD_DCtx_setParameter(ctx, static_cast<ZSTD_dParameter>(0x7fffffff), value);
    return __real_ZSTD_DCtx_setParameter(ctx, parameter, value);
}
extern "C" size_t __wrap_ZSTD_freeDCtx(ZSTD_DCtx *ctx) {
    if (ctx == streamContext) streamContext = nullptr;
    return __real_ZSTD_freeDCtx(ctx);
}
extern "C" size_t __wrap_ZSTD_decompressStream(ZSTD_DCtx *ctx, ZSTD_outBuffer *out, ZSTD_inBuffer *in) {
    if (observe) ++streamCalls;
    const size_t result = __real_ZSTD_decompressStream(ctx, out, in);
    if (observe) contextPeak = std::max(contextPeak, ZSTD_sizeof_DCtx(ctx));
    return result;
}
extern "C" size_t __wrap_ZSTD_decompress(void *out, size_t outSize, const void *in, size_t inSize) {
    if (observe) ++oneShotCalls;
    return __real_ZSTD_decompress(out, outSize, in, inSize);
}

namespace TestFile {
void ObserveSeek() {
    // Rewinding to one-shot decoding must not overlap any streaming allocation.
    assert(liveArrays == 0 && streamContext == nullptr);
}
}

struct Header {
    int revision = 5;
    int compression = 2;
    uint32_t expectedSize = 0;
    uint32_t uncompressedSize = 0;
    char version[32] = "fixture-version";
};
static_assert(sizeof(Header) == 48);

struct Payload {
    const std::vector<unsigned char> &expected;
    int calls = 0;
    void DoState(PointerWrap &p) {
        ++calls;
        assert(p.mode == PointerWrap::MODE_READ);
        assert(expected.empty() || std::memcmp(*p.ptr, expected.data(), expected.size()) == 0);
        p.SkipBytes(expected.size());
    }
};

std::vector<unsigned char> compress(const std::vector<unsigned char> &input, bool knownSize = true) {
    auto ctx = std::unique_ptr<ZSTD_CCtx, decltype(&ZSTD_freeCCtx)>(ZSTD_createCCtx(), ZSTD_freeCCtx);
    assert(ctx);
    assert(!ZSTD_isError(ZSTD_CCtx_setParameter(ctx.get(), ZSTD_c_contentSizeFlag, knownSize ? 1 : 0)));
    assert(!ZSTD_isError(ZSTD_CCtx_setParameter(ctx.get(), ZSTD_c_checksumFlag, 1)));
    std::vector<unsigned char> output(ZSTD_compressBound(input.size()));
    const size_t size = ZSTD_compress2(ctx.get(), output.data(), output.size(), input.data(), input.size());
    assert(!ZSTD_isError(size)); output.resize(size); return output;
}

std::vector<unsigned char> skipped(size_t size) {
    std::vector<unsigned char> output(8 + size, 0x51);
    uint32_t magic = 0x184D2A50, length = static_cast<uint32_t>(size);
    std::memcpy(output.data(), &magic, 4);
    std::memcpy(output.data() + 4, &length, 4);
    return output;
}

struct Metrics { size_t peak, largest, readMaximum, reads, context; };

Metrics run(const std::vector<unsigned char> &encoded, size_t outputSize, int compression = 2,
            size_t failAt = std::numeric_limits<size_t>::max(), int revision = 5, bool badSize = false,
            bool fullVersion = false, bool missing = false, bool windowFallback = false,
            bool failSeek = false, bool failTell = false) {
    std::vector<unsigned char> decoded(outputSize);
    bool valid = false;
    if (compression == 2) {
        const size_t result = ZSTD_decompress(decoded.data(), decoded.size(), encoded.data(), encoded.size());
        valid = !ZSTD_isError(result) && result == outputSize;
    } else if (compression == 1) {
        size_t size = outputSize;
        valid = snappy_uncompress(reinterpret_cast<const char *>(encoded.data()), encoded.size(),
                                  reinterpret_cast<char *>(decoded.data()), &size) == SNAPPY_OK && size == outputSize;
    } else if (compression == 0) {
        decoded = encoded; valid = true;
    }
    const bool stream = TEST_STREAM && !mismatchVersion && !rejectParameter && compression == 2 && !failTell;
    valid = valid && !badSize && !missing && revision >= 4 && failAt == std::numeric_limits<size_t>::max() &&
            !(stream && windowFallback && failSeek);
    Header header;
    header.revision = revision; header.compression = compression;
    header.expectedSize = static_cast<uint32_t>(encoded.size() + (badSize ? 1 : 0));
    header.uncompressedSize = static_cast<uint32_t>(outputSize);
    if (fullVersion) std::memset(header.version, 'v', sizeof(header.version));
    auto &file = TestFile::input;
    file = {};
    file.exists = !missing;
    file.payloadOffset = sizeof(Header) + (revision >= 5 ? 128 : 0);
    file.bytes.resize(file.payloadOffset + encoded.size());
    std::memcpy(file.bytes.data(), &header, sizeof(header));
    std::copy(encoded.begin(), encoded.end(), file.bytes.begin() + file.payloadOffset);
    file.failAt = failAt;
    file.failSeek = failSeek;
    file.failTell = failTell;
    Payload payload{decoded};
    std::string version = "unchanged", reason;
    liveArrays = peakArrays = maxArray = arrayCount = streamCalls = oneShotCalls = contextPeak = 0;
    observe = true;
    const auto result = CChunkFileReader::Load(Path("synthetic-state"), &version, payload, &reason);
    observe = false;
    if ((result == CChunkFileReader::ERROR_NONE) != valid)
        std::fprintf(stderr, "Mismatch: C=%zu U=%zu type=%d I/O failure=%zu revision=%d expectedValid=%d result=%d\n",
                     encoded.size(), outputSize, compression, failAt, revision, valid, result);
    assert((result == CChunkFileReader::ERROR_NONE) == valid);
    assert(payload.calls == (valid ? 1 : 0));
    assert(liveArrays == 0);
    assert(arrayCount == 0);
    assert(streamContext == nullptr);
    assert(file.readsAfterFailure == 0);
    if (valid) assert(version == (fullVersion ? std::string(32, 'v') : "fixture-version"));
    else assert(version == "unchanged");

    if (stream && windowFallback) {
        assert(file.seekCalls == 1);
        assert(file.lastSeekOffset == static_cast<int64_t>(file.payloadOffset));
        assert(streamCalls > 0);
        assert(oneShotCalls == (failSeek ? 0 : 1));
        assert(peakArrays <= outputSize + encoded.size());
    } else if (stream) {
        assert(file.seekCalls == 0);
        assert(oneShotCalls == 0);  // Other corrupt or failed streams must not retry.
        assert(file.maxPayloadRead <= INPUT_LIMIT);
        if (valid && !encoded.empty()) assert(streamCalls > 0);
        assert(peakArrays <= outputSize + std::min(INPUT_LIMIT, encoded.size()));
    } else if (valid) {
        assert(file.seekCalls == 0);
        assert(streamCalls == 0);
        assert(file.payloadReads == 1);
        if (compression == 2) assert(oneShotCalls == 1);
    }
    return {peakArrays, maxArray, file.maxPayloadRead, file.payloadReads, contextPeak};
}

int main(int argc, char **argv) {
    assert(argc == 2);
    std::vector<unsigned char> raw(5 * 1024 * 1024 + 17);
    uint32_t rng = 0x149a395b;
    for (auto &byte : raw) { rng ^= rng << 13; rng ^= rng >> 17; rng ^= rng << 5; byte = static_cast<unsigned char>(rng); }
    const auto frame = compress(raw);
    const auto unknown = compress(raw, false);
    // The seed exceeds a read chunk; its repetitions require LZ references into
    // previous calls' output while still having more than one chunk of input.
    std::vector<unsigned char> repeated;
    for (int i = 0; i != 4; ++i)
        repeated.insert(repeated.end(), raw.begin(), raw.begin() + 3 * INPUT_LIMIT / 2);
    const auto historyFrame = compress(repeated);
    const auto historyUnknown = compress(repeated, false);
    assert(historyFrame.size() > INPUT_LIMIT && historyFrame.size() < repeated.size() / 2);
    assert(historyUnknown.size() > INPUT_LIMIT && historyUnknown.size() < repeated.size() / 2);
    size_t cases = 0;
    auto check = [&](const auto &encoded, size_t size, int type = 2) { ++cases; return run(encoded, size, type); };
    for (int mode = 0; mode != 4; ++mode) {
        mismatchVersion = mode == 1; rejectParameter = mode >= 2 ? mode - 1 : 0;
        const Metrics memory = check(frame, raw.size());
        const bool streaming = TEST_STREAM && mode == 0;
        assert(memory.peak == raw.size() + (streaming ? std::min(INPUT_LIMIT, frame.size()) : frame.size()));
        std::printf("%s mode=%d compressed=%zu output=%zu knownArrayPeak=%zu knownInputPeak=%zu maxRead=%zu reads=%zu zstdStreamContextPeak=%zu\n",
                    argv[1], mode, frame.size(), raw.size(), memory.peak, memory.peak - raw.size(), memory.readMaximum, memory.reads, memory.context);
        std::fflush(stdout);
        check(unknown, raw.size());
        check(historyFrame, repeated.size());
        check(historyUnknown, repeated.size());
        auto wideWindow = unknown;
        assert((wideWindow[4] & 0x20) == 0);
        wideWindow[5] = (28 - 10) << 3; // A legal 256 MiB window with a much smaller output.
        const auto wideMemory = check(wideWindow, raw.size());
        if (streaming) assert(wideMemory.context < INPUT_LIMIT);
        auto maximumWindow = unknown;
        maximumWindow[5] = ((ZSTD_WINDOWLOG_MAX - 10) << 3) | 7;
        auto checkWindow = [&](const auto &encoded, size_t size, int revision = 5,
                               bool failSeek = false, bool failTell = false) {
            ++cases;
            return run(encoded, size, 2, std::numeric_limits<size_t>::max(), revision,
                       false, false, false, true, failSeek, failTell);
        };
        checkWindow(maximumWindow, raw.size());
        checkWindow(maximumWindow, raw.size(), 4);
        checkWindow(maximumWindow, raw.size(), 5, true);
        checkWindow(maximumWindow, raw.size(), 5, false, true);
        auto maximumDamaged = maximumWindow;
        maximumDamaged.back() ^= 0x80;
        checkWindow(maximumDamaged, raw.size());
        auto maximumTruncated = maximumWindow;
        maximumTruncated.pop_back();
        checkWindow(maximumTruncated, raw.size());
        auto maximumJoined = frame;
        maximumJoined.insert(maximumJoined.end(), maximumWindow.begin(), maximumWindow.end());
        checkWindow(maximumJoined, raw.size() * 2);
        const auto empty = compress({});
        check(empty, 0);
        check(skipped(INPUT_LIMIT + 31), 0);
        auto joined = frame;
        const auto skip = skipped(31);
        joined.insert(joined.end(), skip.begin(), skip.end());
        joined.insert(joined.end(), unknown.begin(), unknown.end());
        check(joined, 2 * raw.size());
        auto withEmptyFrames = empty;
        withEmptyFrames.insert(withEmptyFrames.end(), joined.begin(), joined.end());
        withEmptyFrames.insert(withEmptyFrames.end(), empty.begin(), empty.end());
        check(withEmptyFrames, 2 * raw.size());
        auto prefixed = skipped(INPUT_LIMIT + 19);
        prefixed.insert(prefixed.end(), frame.begin(), frame.end());
        check(prefixed, raw.size());
        check(frame, raw.size() - 1); check(frame, raw.size() + 1);
        check(frame, 0); check(std::vector<unsigned char>{}, raw.size());
        check(std::vector<unsigned char>{}, 0);
        for (const size_t size : {size_t{1}, size_t{4}, size_t{5}, INPUT_LIMIT - 1, INPUT_LIMIT, frame.size() - 1}) {
            check(std::vector<unsigned char>(frame.begin(), frame.begin() + size), raw.size());
        }
        auto damaged = frame; damaged.back() ^= 0x80; check(damaged, raw.size());
        auto garbage = frame; garbage.push_back(0xAA); check(garbage, raw.size());
        auto cutSecond = joined; cutSecond.pop_back(); check(cutSecond, raw.size() * 2);
        for (const size_t offset : {size_t{0}, size_t{48}, size_t{176}, size_t{176} + INPUT_LIMIT + 7}) {
            ++cases; run(frame, raw.size(), 2, offset);
        }
        ++cases; run(frame, raw.size(), 2, std::numeric_limits<size_t>::max(), 4);
        ++cases; run(frame, raw.size(), 2, std::numeric_limits<size_t>::max(), 3);
        ++cases; run(frame, raw.size(), 2, std::numeric_limits<size_t>::max(), 5, true);
        ++cases; run(frame, raw.size(), 2, std::numeric_limits<size_t>::max(), 5, false, true);
        ++cases; run(frame, raw.size(), 2, std::numeric_limits<size_t>::max(), 5, false, false, true);
        check(raw, raw.size(), 0);
        size_t length = snappy_max_compressed_length(raw.size());
        std::vector<unsigned char> snappy(length);
        assert(snappy_compress(reinterpret_cast<const char *>(raw.data()), raw.size(),
                               reinterpret_cast<char *>(snappy.data()), &length) == SNAPPY_OK);
        snappy.resize(length);
        check(snappy, raw.size(), 1);
        check(snappy, raw.size() - 1, 1);
        check(frame, raw.size(), 99);
    }
    std::printf("%s: %zu production loader/original codec differential cases passed. Array and streaming context sizes are not whole-process allocation or RSS; one-shot context memory is not observed.\n", argv[1], cases);
}
