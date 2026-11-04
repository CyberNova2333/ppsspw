#!/usr/bin/env python3
"""Exercise production tab-layout decisions without drawing or a game image.

Only the real mode-selection and resize methods are extracted. Screen metrics
and view recreation are test doubles; rendering, tab/scroll persistence and
search interactions still require the complete core in a browser.
"""
import importlib.util
from pathlib import Path
import shutil
import subprocess
import tempfile


def main():
    repo = Path(__file__).resolve().parents[1]
    helper_path = repo / 'scripts/test-sdl-viewport.py'
    spec = importlib.util.spec_from_file_location('viewport_fixture', helper_path)
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    source = (repo / 'deps/ppsspp-wasm/UI/TabbedDialogScreen.cpp').read_text(encoding='utf-8')
    definitions = [
        'bool UITabbedBaseDialogScreen::UseHorizontalTabs() const',
        'void UITabbedBaseDialogScreen::resized()',
    ]
    compiler = shutil.which('em++')
    node = shutil.which('node')
    if not compiler or not node:
        raise SystemExit('Activate the Emscripten SDK and provide Node.js on PATH first.')
    with tempfile.TemporaryDirectory(prefix='ppsspp-tabbed-layout-') as directory:
        fixture = Path(directory)
        (fixture / 'production-tabbed-layout.inc').write_text(
            '\n'.join(definition + ' ' + helper.body(source, definition) for definition in definitions),
            encoding='utf-8')
        for mode in ('web', 'desktop'):
            output = fixture / ('tabbed-layout-' + mode + '.cjs')
            command = [compiler, '-std=c++17', '-sENVIRONMENT=node', '-sEXIT_RUNTIME=1',
                       '-I' + str(fixture), str(repo / 'wasm-page/tests/tabbed-layout.cpp'),
                       '-o', str(output)]
            if mode == 'desktop':
                command.append('-DTEST_DESKTOP_LAYOUT=1')
            subprocess.run(command, check=True)
            subprocess.run([node, str(output)], check=True)


if __name__ == '__main__':
    main()
