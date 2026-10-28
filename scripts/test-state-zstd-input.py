#!/usr/bin/env python3
"""Exercise production state loading against bundled codecs, with synthetic files.

Run in Linux / WSL with CMake and C/C++ compilers. Only platform I/O and logging
are fixtures; Serializer.cpp, its templates and both codecs compile unchanged.
The web preprocessor branch runs natively so allocation observers can inspect it.
"""
from pathlib import Path
import shutil
import shlex
import subprocess
import tempfile


HEADERS = {
    'ppsspp_config.h': '#define PPSSPP_PLATFORM(name) 0\n#define PPSSPP_ARCH(name) 0\n',
    'Common/CommonTypes.h': '''#pragma once
#include <cstddef>
#include <cstdint>
#include <ctime>
using u8 = uint8_t; using u16 = uint16_t; using u32 = uint32_t; using u64 = uint64_t;
using s8 = int8_t; using s16 = int16_t; using s32 = int32_t; using s64 = int64_t;
''',
    'Common/Log.h': '''#pragma once
#include <cassert>
#define INFO_LOG(...)
#define WARN_LOG(...)
#define ERROR_LOG(...)
#define NOTICE_LOG(...)
#define _assert_(value) assert(value)
#define _dbg_assert_(value) assert(value)
#define _dbg_assert_msg_(value, ...) assert(value)
''',
    'Common/Swap.h': 'template<class T, class F> struct swap_struct_t;\n',
    'Common/Data/Collections/LinkedList.h': '',
    'Common/File/Path.h': '''#pragma once
#include <string>
class Path {
public:
    explicit Path(const char *text) : value_(text) {}
    const char *c_str() const { return value_.c_str(); }
private:
    std::string value_;
};
''',
    'Common/StringUtils.h': '''#pragma once
#include <cstring>
template<size_t N> void truncate_cpy(char (&dst)[N], const char *src) {
    std::strncpy(dst, src, N - 1); dst[N - 1] = '\\0';
}
''',
    'Common/File/FileUtil.h': '''#pragma once
#include <algorithm>
#include <cstdio>
#include <cstring>
#include <limits>
#include <vector>
#include "Common/File/Path.h"
namespace TestFile {
struct Data {
    std::vector<unsigned char> bytes;
    size_t payloadOffset = 176;
    size_t failAt = std::numeric_limits<size_t>::max();
    size_t maxPayloadRead = 0;
    size_t payloadReads = 0;
    size_t readsAfterFailure = 0;
    size_t seekCalls = 0;
    int64_t lastSeekOffset = -1;
    bool failSeek = false;
    bool failTell = false;
    bool exists = true;
};
extern Data input;
void ObserveSeek();
}
namespace File {
inline bool Exists(const Path &) { return TestFile::input.exists; }
class IOFile {
public:
    IOFile(const Path &, const char *) {}
    explicit operator bool() const { return good_; }
    uint64_t GetSize() const { return TestFile::input.bytes.size(); }
    uint64_t Tell() const { return TestFile::input.failTell ? uint64_t(-1) : offset_; }
    bool Seek(int64_t offset, int origin) {
        auto &data = TestFile::input;
        ++data.seekCalls;
        data.lastSeekOffset = offset;
        TestFile::ObserveSeek();
        if (data.failSeek || origin != SEEK_SET || offset < 0 || uint64_t(offset) > data.bytes.size())
            return good_ = false;
        offset_ = offset;
        return good_;
    }
    bool ReadBytes(void *dst, size_t length) {
        auto &data = TestFile::input;
        if (!good_) { ++data.readsAfterFailure; return false; }
        if (offset_ >= data.payloadOffset) {
            ++data.payloadReads;
            data.maxPayloadRead = std::max(data.maxPayloadRead, length);
        }
        const size_t end = std::min(data.bytes.size(), data.failAt);
        const size_t count = offset_ < end ? std::min(length, end - offset_) : 0;
        if (count) std::memcpy(dst, data.bytes.data() + offset_, count);
        offset_ += count;
        return good_ = count == length;
    }
    template<class T> bool ReadArray(T *dst, size_t count) { return ReadBytes(dst, sizeof(T) * count); }
    template<class T> bool WriteArray(const T *, size_t) { return false; }
    bool WriteBytes(const void *, size_t) { return false; }
private:
    size_t offset_ = 0;
    bool good_ = true;
};
}
''',
}


def main():
    repo = Path(__file__).resolve().parents[1]
    core = repo / 'deps/ppsspp-wasm'
    compiler, cmake = shutil.which('c++'), shutil.which('cmake')
    if not compiler or not cmake:
        raise SystemExit('Provide CMake and a C++ compiler in Linux / WSL.')
    with tempfile.TemporaryDirectory(prefix='state-zstd-input-') as directory:
        fixture = Path(directory)
        for name, content in HEADERS.items():
            header = fixture / name
            header.parent.mkdir(parents=True, exist_ok=True)
            header.write_text(content, encoding='utf-8')
        # Simulate a system header predating the optional experimental parameter.
        (fixture / 'zstd.h').write_text(
            f'#include "{(core / "ext/zstd/lib/zstd.h").as_posix()}"\n'
            '#ifdef TEST_HIDE_STABLE_PARAMETER\n#undef ZSTD_d_stableOutBuffer\n#endif\n')
        build = fixture / 'zstd-build'
        subprocess.run([cmake, '-S', str(core / 'ext/zstd-build'), '-B', str(build),
                        '-DCMAKE_BUILD_TYPE=Release', '-DCMAKE_C_FLAGS=-DZSTD_DISABLE_ASM'],
                       check=True, stdout=subprocess.DEVNULL)
        subprocess.run([cmake, '--build', str(build), '-j4'], check=True, stdout=subprocess.DEVNULL)
        library, = build.rglob('*zstd_static.a')
        common = [compiler, '-std=c++17', '-O1', '-I' + str(fixture), '-I' + str(core),
                  '-I' + str(core / 'ext/snappy'), '-I' + str(core / 'ext/zstd/lib'),
                  str(core / 'Common/Serialize/Serializer.cpp'),
                  str(repo / 'wasm-page/tests/state-zstd-input.cpp'),
                  *[str(core / 'ext/snappy' / name) for name in
                    ('snappy.cpp', 'snappy-c.cpp', 'snappy-sinksource.cpp', 'snappy-stubs-internal.cpp')],
                  '-pthread',
                  '-Wl,--wrap=ZSTD_versionNumber', '-Wl,--wrap=ZSTD_DCtx_setParameter',
                  '-Wl,--wrap=ZSTD_freeDCtx',
                  '-Wl,--wrap=ZSTD_decompressStream', '-Wl,--wrap=ZSTD_decompress']
        variants = [
            ('web', ['-D__EMSCRIPTEN__', '-DPPSSPP_BUNDLED_ZSTD', '-DTEST_STREAM=1'], [str(library)]),
            ('native', ['-DPPSSPP_BUNDLED_ZSTD', '-DTEST_STREAM=0'], [str(library)]),
            ('old-header', ['-D__EMSCRIPTEN__', '-DPPSSPP_BUNDLED_ZSTD', '-DTEST_HIDE_STABLE_PARAMETER', '-DTEST_STREAM=0'], [str(library)]),
            ('unmarked-web', ['-D__EMSCRIPTEN__', '-DTEST_STREAM=0'], [str(library)]),
        ]
        if shutil.which('pkg-config') and subprocess.run(
                ['pkg-config', '--exists', 'libzstd'], check=False).returncode == 0:
            system_include = Path(subprocess.check_output(
                ['pkg-config', '--variable=includedir', 'libzstd'], text=True).strip()) / 'zstd.h'
            if system_include.is_file():
                wrapper = fixture / 'zstd.h'
                wrapper.write_text(f'#ifdef TEST_SYSTEM_ZSTD\n#include "{system_include}"\n#else\n'
                                   + wrapper.read_text() + '#endif\n')
                system_libraries = shlex.split(subprocess.check_output(
                    ['pkg-config', '--libs', 'libzstd'], text=True))
                variants.append(('system-web', ['-D__EMSCRIPTEN__', '-DTEST_STREAM=0', '-DTEST_SYSTEM_ZSTD'],
                                 system_libraries))
        for name, flags, libraries in variants:
            output = fixture / name
            subprocess.run([*common, *flags, *libraries, '-o', str(output)], check=True)
            subprocess.run([str(output), name], check=True, timeout=90)


if __name__ == '__main__':
    main()
