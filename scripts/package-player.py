#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of PPSSPW and is licensed under GNU AGPLv3 with Additional Terms (see LICENSE and LICENSE-ADDITIONAL_TERMS-zh-CN.md; ref: LICENSE-ADDITIONAL_TERMS-en.md).
"""Copy one matched emulator build into the static player. Never copy game files."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil


REQUIRED_LICENSES = (
    ('LICENSE', 'LICENSE'),
    ('LICENSE.TXT', 'UPSTREAM-LICENSE.txt'),
    ('GPL-3.0.txt', 'GPL-3.0.txt'),
    ('LICENSE-ADDITIONAL_TERMS-zh-CN.md', 'LICENSE-ADDITIONAL_TERMS-zh-CN.md'),
    ('LICENSE-ADDITIONAL_TERMS-en.md', 'LICENSE-ADDITIONAL_TERMS-en.md'),
)


def read_required_licenses(repo, parser):
    """Verify and load all required license texts before modifying output."""
    licenses = []
    for source_name, target_name in REQUIRED_LICENSES:
        source_path = repo / source_name
        if not source_path.is_file():
            parser.error(f'Missing required license file: {source_path}')
        content = source_path.read_bytes()
        if not content:
            parser.error(f'Empty required license file: {source_path}')
        licenses.append((target_name, content))
    return licenses


def diagnostic_metadata(cache_text, javascript):
    """Detect profiling builds even when a prebuilt bundle has no CMake cache."""
    false_values = {'', '0', 'OFF', 'NO', 'FALSE', 'N', 'IGNORE', 'NOTFOUND'}
    features = {
        'irBlockProfile': ('WASM_IR_BLOCK_PROFILE',
                           ('ppssppRequestIRBlockProfile', 'ppssppGetIRBlockProfileMetric')),
        'frameTiming': ('WASM_FRAME_TIMING', ('ppssppRequestFrameTiming', 'ppssppGetFrameTimingMetric')),
    }
    result = {}
    for field, (option, exports) in features.items():
        values = re.findall(rf'^{option}:[^=\r\n]+=(.*)$', cache_text, re.MULTILINE)
        cache_enabled = any(value.strip().upper() not in false_values and
                            not value.strip().upper().endswith('-NOTFOUND') for value in values)
        result[field] = cache_enabled or any(name in javascript for name in exports)
    return result


def resource_metadata(cache_text, source_fingerprint=None):
    """Export only resource numbers; CMake caches can also contain private paths."""
    fields = {'WASM_INITIAL_MEMORY': 'initialMemoryBytes', 'WASM_MAXIMUM_MEMORY': 'maximumMemoryBytes',
              'WASM_COMPUTE_THREADS': 'computeThreads', 'WASM_PTHREAD_POOL_SIZE': 'pthreadPoolSize'}
    bounds = {'WASM_INITIAL_MEMORY': (65536, 4294967296), 'WASM_MAXIMUM_MEMORY': (65536, 4294967296),
              'WASM_COMPUTE_THREADS': (1, 32), 'WASM_PTHREAD_POOL_SIZE': (11, 128)}
    result = {}
    for key, field in fields.items():
        matches = re.findall(rf'^{key}:([^=\r\n]+)=(.*)$', cache_text, re.MULTILINE)
        value = matches[0][1].strip() if len(matches) == 1 and matches[0][0] == 'STRING' else ''
        if key == 'WASM_PTHREAD_POOL_SIZE' and value == 'auto':
            result[field] = 0
        else:
            result[field] = None
            lower, upper = bounds[key]
            if len(value) <= len(str(upper)) and re.fullmatch(r'[1-9][0-9]*', value):
                number = int(value)
                if lower <= number <= upper and (not key.endswith('_MEMORY') or number % 65536 == 0):
                    result[field] = number
    initial, maximum = result['initialMemoryBytes'], result['maximumMemoryBytes']
    if initial is not None and maximum is not None and initial > maximum:
        result['initialMemoryBytes'] = result['maximumMemoryBytes'] = None
    compute, pool = result['computeThreads'], result['pthreadPoolSize']
    if compute is not None and pool is not None:
        if (pool == 0 and compute != 2) or (pool != 0 and pool < compute + max(4, compute) + 6):
            result['computeThreads'] = result['pthreadPoolSize'] = None
    if source_fingerprint is not None and (not isinstance(source_fingerprint, str) or
                                          not re.fullmatch(r'[a-f0-9]{64}', source_fingerprint)):
        raise ValueError('Source fingerprint must be a lowercase SHA-256 digest')
    result['sourceFingerprint'] = source_fingerprint
    return result


def package_offline_shell(output):
    worker = output / 'sw.js'
    if not worker.is_file():
        return
    index = (output / 'index.html').read_text(encoding='utf-8')
    paths = {p for p in output.glob('*.js') if p != worker and
             (not p.name.startswith('main-') or p.name in index)}
    paths.update(p for p in output.glob('*.css') if p.name in index)
    for directory in ('fonts', 'media', 'images', 'icons'):
        paths.update(p for p in (output / directory).rglob('*') if p.suffix.lower() in
                     {'.woff2', '.png', '.svg', '.webp', '.ico'})
    paths.update(p for name in ('index.html', 'manifest.webmanifest', 'assets-manifest.txt', 'build-info.json')
                 if (p := output / name).is_file())
    files = []
    digest = hashlib.sha256()
    for path in sorted(paths):
        name = './' + path.relative_to(output).as_posix()
        files.append(name)
        digest.update(name.encode())
        digest.update(hashlib.sha256(path.read_bytes()).digest())
    manifest = json.dumps({'files': files, 'digest': digest.hexdigest()}, separators=(',', ':'))
    script = worker.read_text(encoding='utf-8')
    script, count = re.subn(r'^const BUILD_SHELL = .*?;$', lambda _: f'const BUILD_SHELL = {manifest};',
                            script, flags=re.MULTILINE)
    if count != 1:
        raise ValueError('Missing offline shell manifest declaration')
    worker.write_text(script, encoding='utf-8')


def main():
    repo = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--build-dir', type=Path, default=repo / 'deps/ppsspp-wasm/build-wasm-release')
    parser.add_argument('--expected-revision', help='For a verified prebuilt bundle without CMakeCache.txt')
    parser.add_argument('--source-fingerprint', help='SHA-256 of the source tree verified by the local build workflow')
    parser.add_argument('--allow-diagnostics', action='store_true',
                        help='Allow profiling artifacts for local testing; do not publish this package')
    args = parser.parse_args()
    source = args.build_dir.resolve()
    output = repo / 'wasm-page/dist/ppsspp-web'
    if not (output / 'index.html').is_file():
        parser.error('Build the web app first: pnpm --dir wasm-page run build:pages')
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
    cache = source / 'CMakeCache.txt'
    cache_text = cache.read_text(encoding='utf-8') if cache.is_file() else ''
    javascript = '\n'.join((source / name).read_text(encoding='utf-8', errors='replace')
                           for name in names if name.endswith('.js'))
    diagnostics = diagnostic_metadata(cache_text, javascript)
    if not args.allow_diagnostics:
        if diagnostics['irBlockProfile']:
            parser.error('IR block profiling artifacts require --allow-diagnostics for local testing')
        if diagnostics['frameTiming']:
            parser.error('Frame timing diagnostic artifacts require --allow-diagnostics for local testing')
    try:
        resources = resource_metadata(cache_text, args.source_fingerprint)
    except ValueError as error:
        parser.error(str(error))
    if args.expected_revision:
        if digest != args.expected_revision:
            parser.error('The emulator artifact revision does not match the expected build')
    else:
        if 'USE_FFMPEG:BOOL=ON' not in cache_text:
            parser.error('Use a local FFmpeg-enabled build, or supply a verified --expected-revision')
    license_contents = read_required_licenses(repo, parser)
    destination = output / 'build-wasm'
    destination.mkdir(exist_ok=True)
    for name in names:
        shutil.copy2(source / name, destination / name)
    # A worker file from an earlier build must not survive a switch to an embedded worker.
    if 'PPSSPPSDL.worker.js' not in names:
        (destination / 'PPSSPPSDL.worker.js').unlink(missing_ok=True)
    (output / 'build-info.json').write_text(json.dumps({'revision': digest, 'resources': resources,
                                                      'diagnostics': diagnostics}, indent=2) + '\n', encoding='utf-8')
    for target_name, content in license_contents:
        (output / target_name).write_bytes(content)
    package_offline_shell(output)
    print(f'Packaged {len(names)} emulator artifacts: {digest}')


if __name__ == '__main__':
    main()
