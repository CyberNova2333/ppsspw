#!/usr/bin/env python3
"""Test production NO_MMAP arena ownership with an allocation-counting fixture.

Run on Linux or WSL with a C++ compiler. Linker wrappers replace only the arena's
160 MiB malloc request with tiny test storage; views are never dereferenced.
The production MemArenaPosix implementation and header compile unchanged.
"""
from pathlib import Path
import shutil
import subprocess
import tempfile


HEADERS = {
    'ppsspp_config.h': '#define PPSSPP_PLATFORM(name) 0\n#define PPSSPP_ARCH(name) 0\n',
    'Common/CommonTypes.h': '#include <cstddef>\n#include <cstdint>\nusing u8 = uint8_t; using s64 = int64_t;\n',
    'Common/Log.h': '#define INFO_LOG(...)\n#define WARN_LOG(...)\n#define ERROR_LOG(...)\n#define NOTICE_LOG(...)\n',
    'Common/File/FileUtil.h': '',
    'Common/MemoryUtil.h': '',
}


def main():
    repo = Path(__file__).resolve().parents[1]
    core = repo / 'deps/ppsspp-wasm'
    compiler = shutil.which('c++')
    if not compiler:
        raise SystemExit('Provide a C++ compiler on PATH in Linux or WSL.')
    with tempfile.TemporaryDirectory(prefix='no-mmap-arena-') as directory:
        fixture = Path(directory)
        for name, content in HEADERS.items():
            header = fixture / name
            header.parent.mkdir(parents=True, exist_ok=True)
            header.write_text(content, encoding='utf-8')
        output = fixture / 'arena-test'
        subprocess.run([
            compiler, '-std=c++17', '-DNO_MMAP', '-I' + str(fixture), '-I' + str(core),
            str(core / 'Common/MemArenaPosix.cpp'), str(repo / 'wasm-page/tests/no-mmap-arena.cpp'),
            '-Wl,--wrap=malloc', '-Wl,--wrap=free', '-o', str(output),
        ], check=True)
        subprocess.run([str(output)], check=True, timeout=10)


if __name__ == '__main__':
    main()
