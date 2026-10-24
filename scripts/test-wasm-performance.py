#!/usr/bin/env python3
"""Test the production Wasm metric publisher with deterministic core clocks.

Run with an activated Emscripten SDK and Node.js on PATH. The stubs replace only
core inputs; the real publisher, atomic scalar ABI and rate calculations compile
to WebAssembly. Temporary fixtures do not contain or read any game data.
"""
from pathlib import Path
import shutil
import subprocess
import tempfile


HEADERS = {
    'Common/Thread/ThreadManager.h': '''struct ThreadManager {
  bool initialized = true;
  int computeThreads = 2;
  int allThreads = 6;
  bool IsInitialized() const { return initialized; }
  int GetNumLooperThreads() const { return computeThreads; }
  int GetNumThreads() const { return allThreads; }
};
extern ThreadManager g_threadManager;
''',
    'Common/TimeUtil.h': 'double time_now_d();\n',
    'Core/Config.h': 'struct TestConfig { int iDisplayRefreshRate = 60; }; extern TestConfig g_Config;\n',
    'Core/ConfigValues.h': '#pragma once\nenum class CPUCore { INTERPRETER = 0, JIT = 1, IR_INTERPRETER = 2, JIT_IR = 3 };\n',
    'Core/Core.h': 'bool Core_IsActive(); bool Core_IsStepping();\n',
    'Core/CoreTiming.h': '#include <cstdint>\nnamespace CoreTiming { uint64_t GetGlobalTimeUs(); }\n',
    'Core/HW/Display.h': 'int __DisplayGetNumVblanks(); int __DisplayGetFlipCount(); void __DisplayGetFPS(float*,float*,float*);\n',
    'Core/System.h': '''#include "Core/ConfigValues.h"
enum { UISTATE_MENU, UISTATE_PAUSEMENU, UISTATE_INGAME };
bool PSP_IsInited(); int GetUIState();
struct TestCoreParameter { CPUCore cpuCore = CPUCore::IR_INTERPRETER; };
TestCoreParameter &PSP_CoreParameter();
''',
}


def main():
    repo = Path(__file__).resolve().parents[1]
    core = repo / 'deps/ppsspp-wasm'
    compiler, node = shutil.which('em++'), shutil.which('node')
    if not compiler or not node:
        raise SystemExit('Activate the Emscripten SDK and provide Node.js on PATH first.')
    with tempfile.TemporaryDirectory(prefix='ppsspp-performance-') as directory:
        fixture = Path(directory)
        for name, content in HEADERS.items():
            header = fixture / name
            header.parent.mkdir(parents=True, exist_ok=True)
            header.write_text(content, encoding='utf-8')
        output = fixture / 'performance-test.cjs'
        subprocess.run([
            compiler, '-pthread', '-sENVIRONMENT=node', '-sEXIT_RUNTIME=1', '-sASSERTIONS=0',
            '-sPTHREAD_POOL_SIZE=2', '-sINITIAL_MEMORY=16777216',
            '-sMAXIMUM_MEMORY=134217728', '-sALLOW_MEMORY_GROWTH=1', '-sMALLOC=mimalloc',
            '-Wl,--wrap=emscripten_resize_heap',
            '-DPPSSPP_WASM_INITIAL_MEMORY=16777216', '-DPPSSPP_WASM_MAXIMUM_MEMORY=134217728',
            '-DPPSSPP_WASM_COMPUTE_THREADS=2', '-DPPSSPP_WASM_PTHREAD_POOL_SIZE=2',
            '-I' + str(fixture), '-I' + str(core),
            str(core / 'SDL/WasmPerformance.cpp'),
            str(repo / 'wasm-page/tests/core-performance.cpp'), '-o', str(output),
        ], check=True)
        subprocess.run([node, str(output)], check=True)


if __name__ == '__main__':
    main()
