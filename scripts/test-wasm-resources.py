#!/usr/bin/env python3
"""Validate production CMake resource settings without building the emulator."""
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


MODULE = Path(__file__).resolve().parents[1] / 'deps/ppsspp-wasm/cmake/WasmResources.cmake'


class WasmResourceSettings(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cmake = shutil.which('cmake')
        if not cls.cmake:
            raise RuntimeError('CMake must be available on PATH.')

    def configure(self, **settings):
        with tempfile.TemporaryDirectory(prefix='wasm-resources-') as directory:
            root = Path(directory)
            script = root / 'validate.cmake'
            script.write_text(
                'cmake_minimum_required(VERSION 3.16)\n'
                f'include([==[{MODULE.as_posix()}]==])\n'
                'file(WRITE "${CMAKE_CURRENT_LIST_DIR}/result.txt"\n'
                '  "initial=${WASM_INITIAL_MEMORY}\\n"\n'
                '  "maximum=${WASM_MAXIMUM_MEMORY}\\n"\n'
                '  "compute=${WASM_COMPUTE_THREADS}\\n"\n'
                '  "io=${WASM_IO_THREADS}\\n"\n'
                '  "pool=${WASM_PTHREAD_POOL_SIZE_METRIC}\\n"\n'
                '  "expression=${WASM_PTHREAD_POOL_EXPRESSION}\\n")\n',
                encoding='utf-8',
            )
            result = subprocess.run(
                [self.cmake, *[f'-D{name}={value}' for name, value in settings.items()], '-P', str(script)],
                capture_output=True, text=True, check=False,
            )
            output = None
            if result.returncode == 0:
                output = dict(line.split('=', 1) for line in (root / 'result.txt').read_text().splitlines())
                output = {name: value if name == 'expression' else int(value) for name, value in output.items()}
            return result, output

    def test_defaults_preserve_current_resources(self):
        result, config = self.configure()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(config, {
            'initial': 536870912, 'maximum': 4294967296, 'compute': 2, 'io': 4, 'pool': 0,
            'expression': 'Math.max(4,navigator.hardwareConcurrency||4)',
        })

    def test_memory_variants_leave_worker_configuration_unchanged(self):
        for megabytes in (256, 384, 512):
            with self.subTest(megabytes=megabytes):
                result, config = self.configure(WASM_INITIAL_MEMORY=megabytes * 1024 * 1024)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(config['initial'], megabytes * 1024 * 1024)
                self.assertEqual((config['compute'], config['io'], config['pool']), (2, 4, 0))

    def test_memory_rejects_malformed_out_of_range_unaligned_and_inverted_values(self):
        for name in ('WASM_INITIAL_MEMORY', 'WASM_MAXIMUM_MEMORY'):
            for value in ('0', '-1', '256MB', '1.5', '65537', '4295032832', '99999999999999999999999', '1;2'):
                with self.subTest(name=name, value=value):
                    result, _ = self.configure(**{name: value})
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn(name, result.stderr)
        result, _ = self.configure(WASM_INITIAL_MEMORY=536870912, WASM_MAXIMUM_MEMORY=268435456)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('must not exceed', result.stderr)

    def test_fixed_pool_accounts_for_compute_and_io_workers(self):
        for compute, io, pool in ((1, 4, 11), (2, 4, 12), (4, 4, 14), (5, 5, 16)):
            with self.subTest(compute=compute):
                result, config = self.configure(WASM_COMPUTE_THREADS=compute, WASM_PTHREAD_POOL_SIZE=pool)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual((config['compute'], config['io'], config['pool']), (compute, io, pool))
                self.assertEqual(config['expression'], str(pool))
                result, _ = self.configure(WASM_COMPUTE_THREADS=compute, WASM_PTHREAD_POOL_SIZE=pool - 1)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('WASM_PTHREAD_POOL_SIZE', result.stderr)

    def test_worker_counts_reject_unsupported_inputs(self):
        for name, values in {
            'WASM_COMPUTE_THREADS': ('0', '-1', '1.5', '33', 'auto'),
            'WASM_PTHREAD_POOL_SIZE': ('0', '-1', '12.5', '129', 'navigator.hardwareConcurrency', '12;13'),
        }.items():
            for value in values:
                with self.subTest(name=name, value=value):
                    result, _ = self.configure(**{name: value})
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn(name, result.stderr)

    def test_custom_compute_requires_a_bounded_precreated_pool(self):
        result, _ = self.configure(WASM_COMPUTE_THREADS=1)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('requires a fixed WASM_PTHREAD_POOL_SIZE', result.stderr)


if __name__ == '__main__':
    unittest.main(verbosity=2)
