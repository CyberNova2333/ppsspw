#!/usr/bin/env python3
"""Compile the actual bounded swap-timing module and exercise its atomic ABI."""
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
    with tempfile.TemporaryDirectory(prefix='wasm-frame-timing-') as directory:
        output = Path(directory) / ('timing-test.exe' if os.name == 'nt' else 'timing-test')
        options = [compiler, '-std=c++17', '-O2', '-Wall', '-Wextra', '-Werror', '-pthread', '-I' + str(core)]
        source = str(core / 'Common/GPU/WasmFrameTiming.cpp')
        subprocess.run(options + [
            '-DPPSSPP_WASM_FRAME_TIMING=1',
            '-DPPSSPP_WASM_FRAME_TIMING_CAPACITY=8',
            '-DPPSSPP_WASM_FRAME_TIMING_MAX_REQUESTS=4096',
            source, str(repo / 'wasm-page/tests/wasm-frame-timing.cpp'), '-o', str(output),
        ], check=True, timeout=60, env=environment)
        subprocess.run([str(output)], check=True, timeout=30, env=environment)
        # The flag-OFF object must contain neither request/getter nor hook code.
        disabled = Path(directory) / 'disabled.o'
        subprocess.run(options + ['-c', source, '-o', str(disabled)],
                       check=True, timeout=30, env=environment)
        nm = shutil.which('nm') or shutil.which('llvm-nm')
        if not nm:
            raise SystemExit('Provide nm or llvm-nm to verify the flag-OFF object.')
        symbols = subprocess.run([nm, '-g', str(disabled)], check=True, capture_output=True,
                                 text=True, timeout=10, env=environment).stdout
        if 'FrameTiming' in symbols:
            raise SystemExit('Flag-OFF compilation retained frame timing code.')
        print('Flag-OFF module contains no frame timing symbols.')


if __name__ == '__main__':
    main()
