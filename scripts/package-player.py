#!/usr/bin/env python3
"""Copy one matched emulator build into the static player. Never copy game files."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil


def main():
    repo = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--build-dir', type=Path, default=repo / 'deps/ppsspp-wasm/build-wasm-release')
    parser.add_argument('--expected-revision', help='For a verified prebuilt bundle without CMakeCache.txt')
    args = parser.parse_args()
    source = args.build_dir.resolve()
    output = repo / 'wasm-page/dist/ppsspp-web'
    if not (output / 'index.html').is_file():
        parser.error('Build the web app first: npm --prefix wasm-page run build:pages')
    names = ['PPSSPPSDL.js', 'PPSSPPSDL.wasm', 'PPSSPPSDL.data']
    if (source / 'PPSSPPSDL.worker.js').is_file():
        names.append('PPSSPPSDL.worker.js')
    revision = hashlib.sha256()
    for name in names:
        path = source / name
        if not path.is_file():
            parser.error(f'Missing artifact: {path}')
        revision.update(name.encode())
        with path.open('rb') as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                revision.update(chunk)
    digest = revision.hexdigest()
    if args.expected_revision:
        if digest != args.expected_revision:
            parser.error('The emulator artifact revision does not match the expected build')
    else:
        cache = source / 'CMakeCache.txt'
        if not cache.is_file() or 'USE_FFMPEG:BOOL=ON' not in cache.read_text(encoding='utf-8'):
            parser.error('Use a local FFmpeg-enabled build, or supply a verified --expected-revision')
    destination = output / 'build-wasm'
    destination.mkdir(exist_ok=True)
    for name in names:
        shutil.copy2(source / name, destination / name)
    # A worker file from an earlier build must not survive a switch to an embedded worker.
    if 'PPSSPPSDL.worker.js' not in names:
        (destination / 'PPSSPPSDL.worker.js').unlink(missing_ok=True)
    (output / 'build-info.json').write_text(json.dumps({'revision': digest}, indent=2) + '\n', encoding='utf-8')
    (output / 'LICENSE').write_bytes((repo / 'LICENSE').read_bytes())
    (output / 'UPSTREAM-LICENSE.txt').write_bytes((repo / 'LICENSE.TXT').read_bytes())
    print(f'Packaged {len(names)} emulator artifacts: {digest}')


if __name__ == '__main__':
    main()
