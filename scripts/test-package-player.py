#!/usr/bin/env python3
"""Check packaged resource provenance and that private build metadata stays local."""
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).with_name('package-player.py')
SPEC = importlib.util.spec_from_file_location('package_player', SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
DEFAULT_CACHE = '\n'.join((
    'USE_FFMPEG:BOOL=ON',
    'WASM_INITIAL_MEMORY:STRING=536870912',
    'WASM_MAXIMUM_MEMORY:STRING=4294967296',
    'WASM_COMPUTE_THREADS:STRING=2',
    'WASM_PTHREAD_POOL_SIZE:STRING=auto',
)) + '\n'
DEFAULT_RESOURCES = {
    'initialMemoryBytes': 536870912, 'maximumMemoryBytes': 4294967296,
    'computeThreads': 2, 'pthreadPoolSize': 0, 'sourceFingerprint': None,
}


class ResourceMetadata(unittest.TestCase):
    def test_only_allowlisted_numbers_and_verified_digest_leave_cache(self):
        cache = DEFAULT_CACHE + 'PRIVATE_BUILD_PATH:PATH=/private/location\nOTHER_VALUE:STRING=confidential\n'
        result = MODULE.resource_metadata(cache, 'a' * 64)
        self.assertEqual(result, {**DEFAULT_RESOURCES, 'sourceFingerprint': 'a' * 64})
        self.assertNotIn('private', json.dumps(result))
        self.assertNotIn('confidential', json.dumps(result))

    def test_missing_cache_preserves_unknown_values(self):
        self.assertEqual(MODULE.resource_metadata(''), {key: None for key in DEFAULT_RESOURCES})

    def test_rejects_malformed_out_of_range_unaligned_and_ambiguous_values(self):
        cases = {
            'WASM_INITIAL_MEMORY': ('0', '65535', '65537', '4295032832', '-1', '1.5', 'private-value', '9' * 5000),
            'WASM_MAXIMUM_MEMORY': ('0', '65537', '4295032832'),
            'WASM_COMPUTE_THREADS': ('0', '33', 'auto', '2;3'),
            'WASM_PTHREAD_POOL_SIZE': ('0', '10', '129', 'navigator.hardwareConcurrency'),
        }
        fields = {'WASM_INITIAL_MEMORY': 'initialMemoryBytes', 'WASM_MAXIMUM_MEMORY': 'maximumMemoryBytes',
                  'WASM_COMPUTE_THREADS': 'computeThreads', 'WASM_PTHREAD_POOL_SIZE': 'pthreadPoolSize'}
        for key, values in cases.items():
            for value in values:
                with self.subTest(key=key, value=value[:30]):
                    result = MODULE.resource_metadata(f'{key}:STRING={value}\n')
                    self.assertIsNone(result[fields[key]])
            duplicate = MODULE.resource_metadata(DEFAULT_CACHE + f'{key}:STRING=123\n')
            self.assertIsNone(duplicate[fields[key]])
            conflicting_type = MODULE.resource_metadata(DEFAULT_CACHE + f'{key}:PATH=/private/build\n')
            self.assertIsNone(conflicting_type[fields[key]])

    def test_rejects_inconsistent_cross_field_configuration(self):
        inverted = DEFAULT_CACHE.replace('WASM_MAXIMUM_MEMORY:STRING=4294967296', 'WASM_MAXIMUM_MEMORY:STRING=268435456')
        result = MODULE.resource_metadata(inverted)
        self.assertIsNone(result['initialMemoryBytes'])
        self.assertIsNone(result['maximumMemoryBytes'])
        for altered in (DEFAULT_CACHE.replace('THREADS:STRING=2', 'THREADS:STRING=1'),
                        DEFAULT_CACHE.replace('POOL_SIZE:STRING=auto', 'POOL_SIZE:STRING=11')):
            result = MODULE.resource_metadata(altered)
            self.assertIsNone(result['computeThreads'])
            self.assertIsNone(result['pthreadPoolSize'])
        fixed = MODULE.resource_metadata(DEFAULT_CACHE.replace('POOL_SIZE:STRING=auto', 'POOL_SIZE:STRING=12'))
        self.assertEqual(fixed['pthreadPoolSize'], 12)
        self.assertEqual(fixed['computeThreads'], 2)

    def test_source_fingerprint_rejects_non_sha256_values(self):
        for invalid in ('', 'A' * 64, 'g' * 64, 'a' * 63, 'a' * 65, 'private/path', 123):
            with self.subTest(value=invalid):
                with self.assertRaisesRegex(ValueError, 'lowercase SHA-256'):
                    MODULE.resource_metadata(DEFAULT_CACHE, invalid)


class PackageIntegration(unittest.TestCase):
    def test_metadata_matches_artifacts_and_no_unlisted_file_is_copied(self):
        with tempfile.TemporaryDirectory(prefix='player-package-') as directory:
            repo = Path(directory)
            (repo / 'scripts').mkdir()
            script = repo / 'scripts/package-player.py'
            shutil.copyfile(SCRIPT, script)
            output = repo / 'wasm-page/dist/ppsspp-web'
            output.mkdir(parents=True)
            (output / 'index.html').write_text('<!doctype html>')
            destination = output / 'build-wasm'
            destination.mkdir()
            (destination / 'PPSSPPSDL.worker.js').write_text('stale worker')
            (repo / 'LICENSE').write_text('License')
            (repo / 'LICENSE.TXT').write_text('Upstream license')
            source = repo / 'compilation-output'
            source.mkdir()
            expected = hashlib.sha256()
            for name in ('PPSSPPSDL.js', 'PPSSPPSDL.wasm', 'PPSSPPSDL.data'):
                content = name.encode()
                (source / name).write_bytes(content)
                expected.update(name.encode())
                expected.update(content)
            (source / 'CMakeCache.txt').write_text(DEFAULT_CACHE + 'PRIVATE:PATH=/private/build\n')
            (source / 'game.iso').write_bytes(b'not-a-build-artifact')
            subprocess.run([sys.executable, str(script), '--build-dir', str(source),
                            '--source-fingerprint', 'b' * 64], capture_output=True, check=True)
            metadata = json.loads((output / 'build-info.json').read_text())
            self.assertEqual(metadata, {'revision': expected.hexdigest(),
                                        'resources': {**DEFAULT_RESOURCES, 'sourceFingerprint': 'b' * 64},
                                        'diagnostics': {'irBlockProfile': False}})
            self.assertEqual(sorted(path.name for path in destination.iterdir()),
                             ['PPSSPPSDL.data', 'PPSSPPSDL.js', 'PPSSPPSDL.wasm'])


class DiagnosticPackaging(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='player-package-diagnostics-')
        self.addCleanup(temporary.cleanup)
        self.repo = Path(temporary.name)
        (self.repo / 'scripts').mkdir()
        self.script = self.repo / 'scripts/package-player.py'
        shutil.copyfile(SCRIPT, self.script)
        self.output = self.repo / 'wasm-page/dist/ppsspp-web'
        self.output.mkdir(parents=True)
        (self.output / 'index.html').write_text('<!doctype html>')
        (self.repo / 'LICENSE').write_text('License')
        (self.repo / 'LICENSE.TXT').write_text('Upstream license')
        self.source = self.repo / 'compilation-output'
        self.source.mkdir()
        for name in ('PPSSPPSDL.js', 'PPSSPPSDL.wasm', 'PPSSPPSDL.data'):
            (self.source / name).write_bytes(name.encode())

    def package(self, *arguments):
        return subprocess.run([sys.executable, str(self.script), '--build-dir', str(self.source), *arguments],
                              capture_output=True, text=True)

    def revision_arguments(self):
        digest = hashlib.sha256()
        for name in ('PPSSPPSDL.js', 'PPSSPPSDL.wasm', 'PPSSPPSDL.data'):
            digest.update(name.encode())
            digest.update((self.source / name).read_bytes())
        return ('--expected-revision', digest.hexdigest())

    def output_snapshot(self):
        return {str(path.relative_to(self.output)): path.read_bytes()
                for path in self.output.rglob('*') if path.is_file()}

    def test_cache_truth_values_refuse_before_writing_dist_even_with_verified_revision(self):
        for value in ('ON', 'TRUE', 'YES', 'Y', '1', '-1'):
            with self.subTest(value=value):
                (self.source / 'CMakeCache.txt').write_text(DEFAULT_CACHE + f'WASM_IR_BLOCK_PROFILE:BOOL={value}\n')
                before = self.output_snapshot()
                result = self.package(*self.revision_arguments())
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('--allow-diagnostics', result.stderr)
                self.assertEqual(self.output_snapshot(), before)
                self.assertFalse((self.output / 'build-wasm').exists())

    def test_exports_refuse_prebuilt_and_cache_off_bundles_without_changing_existing_dist(self):
        destination = self.output / 'build-wasm'
        destination.mkdir()
        (destination / 'PPSSPPSDL.js').write_text('previous release')
        (self.output / 'build-info.json').write_text('{"previous": true}')
        for cache in (None, DEFAULT_CACHE + 'WASM_IR_BLOCK_PROFILE:BOOL=OFF\n'):
            for name in ('ppssppRequestIRBlockProfile', 'ppssppGetIRBlockProfileMetric'):
                with self.subTest(cache_present=cache is not None, export=name):
                    if cache is not None:
                        (self.source / 'CMakeCache.txt').write_text(cache)
                    (self.source / 'PPSSPPSDL.js').write_text(f'Module["_{name}"] = wasmExports["{name}"];')
                    before = self.output_snapshot()
                    result = self.package(*self.revision_arguments())
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn('--allow-diagnostics', result.stderr)
                    self.assertEqual(self.output_snapshot(), before)

    def test_disabled_or_legacy_prebuilt_packages_are_not_diagnostics(self):
        for value in (None, 'OFF', 'FALSE', 'NO', 'N', '0', '', 'IGNORE', 'NOTFOUND', 'option-NOTFOUND'):
            with self.subTest(value=value):
                if value is not None:
                    (self.source / 'CMakeCache.txt').write_text(DEFAULT_CACHE + f'WASM_IR_BLOCK_PROFILE:BOOL={value}\n')
                result = self.package(*self.revision_arguments())
                self.assertEqual(result.returncode, 0, result.stderr)
                metadata = json.loads((self.output / 'build-info.json').read_text())
                self.assertEqual(metadata['diagnostics'], {'irBlockProfile': False})

    def test_explicit_override_marks_diagnostics_from_cache_or_prebuilt_exports(self):
        for cache, javascript in ((DEFAULT_CACHE + 'WASM_IR_BLOCK_PROFILE:BOOL=ON\n', 'normal exports'),
                                  (None, 'Module["_ppssppRequestIRBlockProfile"] = function() {};')):
            with self.subTest(cache_present=cache is not None):
                if cache is None:
                    (self.source / 'CMakeCache.txt').unlink(missing_ok=True)
                else:
                    (self.source / 'CMakeCache.txt').write_text(cache)
                (self.source / 'PPSSPPSDL.js').write_text(javascript)
                result = self.package('--allow-diagnostics', *self.revision_arguments())
                self.assertEqual(result.returncode, 0, result.stderr)
                metadata = json.loads((self.output / 'build-info.json').read_text())
                self.assertEqual(metadata['diagnostics'], {'irBlockProfile': True})
                self.assertEqual((self.output / 'build-wasm/PPSSPPSDL.js').read_text(), javascript)


if __name__ == '__main__':
    unittest.main(verbosity=2)
