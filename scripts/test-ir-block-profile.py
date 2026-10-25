#!/usr/bin/env python3
"""Compile the production IR block profiler and exercise its browser ABI natively."""
from pathlib import Path
import os
import shutil
import subprocess
import tempfile


def main():
    repo = Path(__file__).resolve().parents[1]
    core = repo / 'deps/ppsspp-wasm'
    compiler = next((path for name in ('c++', 'g++', 'clang++')
                     if (path := shutil.which(name))), None)
    if not compiler:
        raise SystemExit('Provide a native C++17 compiler on PATH.')
    environment = os.environ.copy()
    environment['PATH'] = str(Path(compiler).parent) + os.pathsep + environment.get('PATH', '')
    with tempfile.TemporaryDirectory(prefix='ir-block-profile-') as directory:
        output = Path(directory) / ('profile-test.exe' if os.name == 'nt' else 'profile-test')
        subprocess.run([
            compiler, '-std=c++17', '-O2', '-Wall', '-Wextra', '-Werror', '-pthread',
            '-DPPSSPP_WASM_IR_BLOCK_PROFILE=1',
            '-DPPSSPP_WASM_IR_PROFILE_MAX_BLOCKS=128',
            '-DPPSSPP_WASM_IR_PROFILE_MAX_INSTRUCTIONS=1024',
            '-DPPSSPP_WASM_IR_PROFILE_MAX_COUNTER=8192',
            '-I' + str(core), str(core / 'Core/MIPS/IR/IRBlockProfile.cpp'),
            str(repo / 'wasm-page/tests/ir-block-profile.cpp'), '-o', str(output),
        ], check=True, timeout=60, env=environment)
        subprocess.run([str(output)], check=True, timeout=30, env=environment)


if __name__ == '__main__':
    main()
