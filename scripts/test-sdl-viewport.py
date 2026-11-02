#!/usr/bin/env python3
"""Compile the production SDL resize branch with deterministic window metrics.

This checks resize behaviour, including the DPI visible to Native_UpdateScreenScale,
without a GPU, game files or a complete emulator build. SDL calls are test doubles;
this is not browser or native rendering acceptance.
"""
from pathlib import Path
import re
import shutil
import subprocess
import tempfile


def body(source, marker):
    if source.count(marker) != 1:
        raise ValueError(f'Expected one production definition: {marker}')
    start = source.index('{', source.index(marker))
    # Mask comments and literals while retaining positions for balanced braces.
    masked = re.sub(r'//[^\n]*|/\*[\s\S]*?\*/|"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\'',
                    lambda match: ' ' * len(match.group()), source)
    depth = 0
    for index in range(start, len(masked)):
        depth += (masked[index] == '{') - (masked[index] == '}')
        if depth == 0:
            return source[start:index + 1]
    raise ValueError(f'Unclosed production definition: {marker}')


def main():
    repo = Path(__file__).resolve().parents[1]
    source = (repo / 'deps/ppsspp-wasm/SDL/SDLMain.cpp').read_text(encoding='utf-8')
    compiler = shutil.which('em++')
    node = shutil.which('node')
    if not compiler or not node:
        raise SystemExit('Activate the Emscripten SDK and provide Node.js on PATH first.')
    with tempfile.TemporaryDirectory(prefix='ppsspp-sdl-viewport-') as directory:
        fixture = Path(directory)
        (fixture / 'production-resize.inc').write_text(
            'static void UpdateScreenDPI(SDL_Window *window) '
            + body(source, 'static void UpdateScreenDPI(SDL_Window *window)')
            + '\nstatic void Resize(SDL_Window *window, const SDL_Event &event) { do '
            + body(source, 'case SDL_WINDOWEVENT_SIZE_CHANGED:')
            + ' while (false); }\n', encoding='utf-8')
        output = fixture / 'sdl-viewport.cjs'
        subprocess.run([
            compiler, '-std=c++17', '-sENVIRONMENT=node', '-sEXIT_RUNTIME=1',
            '-I' + str(fixture), str(repo / 'wasm-page/tests/sdl-viewport.cpp'),
            '-o', str(output),
        ], check=True)
        subprocess.run([node, str(output)], check=True)


if __name__ == '__main__':
    main()
