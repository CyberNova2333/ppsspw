#!/usr/bin/env python3
"""Test source provenance against isolated Git inventories and compilation trees."""
import importlib.util
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).with_name('fingerprint-wasm-source.py')
SPEC = importlib.util.spec_from_file_location('fingerprint_source', SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class SourceFingerprint(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='wasm-source-test-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.repo = self.root / 'inventory'
        self.repo.mkdir()
        self.git('init', '-q')
        self.git('config', 'core.autocrlf', 'false')
        self.core = self.repo / 'deps/ppsspp-wasm'
        self.core.mkdir(parents=True)
        (self.repo / '.gitignore').write_text('/deps/ppsspp-wasm/build-wasm/\n/resources/\n')
        (self.core / 'a.cpp').write_bytes(b'int value = 1;\n')
        (self.core / 'b.h').write_bytes(b'#pragma once\n')
        self.git('add', '.gitignore', 'deps/ppsspp-wasm/a.cpp', 'deps/ppsspp-wasm/b.h')

    def git(self, *args):
        subprocess.run(['git', '-C', str(self.repo), *args], capture_output=True, check=True)

    def fingerprint(self, source=None):
        return MODULE.fingerprint_source(source, self.repo)

    def test_reads_actual_compilation_bytes_and_includes_untracked_sources(self):
        (self.core / 'new.h').write_bytes(b'#define NEW 1\n')
        cached = self.root / 'compilation'
        shutil.copytree(self.core, cached)
        initial = self.fingerprint()
        self.assertEqual(initial, self.fingerprint(cached))
        (cached / 'a.cpp').write_bytes(b'int value = 2;\n')
        self.assertNotEqual(initial, self.fingerprint(cached))
        self.assertEqual(initial, self.fingerprint())
        (cached / 'a.cpp').write_bytes((self.core / 'a.cpp').read_bytes())
        (cached / 'new.h').write_bytes(b'#define NEW 2\n')
        self.assertNotEqual(initial, self.fingerprint(cached))

    def test_ignored_build_outputs_and_files_outside_core_do_not_affect_digest(self):
        initial = self.fingerprint()
        generated = self.core / 'build-wasm'
        generated.mkdir()
        (generated / 'private-cache.txt').write_bytes(b'private-build-information')
        (self.repo / 'resources').mkdir()
        (self.repo / 'resources/game.iso').write_bytes(b'not-source')
        (self.repo / 'README.md').write_bytes(b'Outside core inventory')
        self.assertEqual(initial, self.fingerprint())

    def test_sorted_paths_and_lengths_are_unambiguous(self):
        initial = self.fingerprint()
        original = MODULE.git_output

        def reverse_listing(root, *args):
            value = original(root, *args)
            if args[0] == 'ls-files':
                return b'\0'.join(reversed(value.rstrip(b'\0').split(b'\0'))) + b'\0'
            return value

        with patch.object(MODULE, 'git_output', side_effect=reverse_listing):
            self.assertEqual(initial, self.fingerprint())
        # Moving identical bytes to a different inventoried path changes the digest.
        self.git('mv', 'deps/ppsspp-wasm/b.h', 'deps/ppsspp-wasm/c.h')
        self.assertNotEqual(initial, self.fingerprint())

    def test_missing_tracked_file_is_an_error_instead_of_a_partial_digest(self):
        (self.core / 'b.h').unlink()
        with self.assertRaisesRegex(MODULE.FingerprintError, 'missing or unreadable'):
            self.fingerprint()

    def test_source_links_cannot_escape_compilation_tree(self):
        cached = self.root / 'compilation'
        shutil.copytree(self.core, cached)
        external = self.root / 'private-source'
        external.write_bytes(b'private-source-data')
        (cached / 'a.cpp').unlink()
        try:
            (cached / 'a.cpp').symlink_to(external)
        except OSError:
            self.skipTest('This environment does not allow creating symbolic links.')
        with self.assertRaisesRegex(MODULE.FingerprintError, 'escapes'):
            self.fingerprint(cached)

    def test_cli_emits_only_digest_or_sanitized_failure(self):
        args = [sys.executable, str(SCRIPT), '--inventory-root', str(self.repo)]
        success = subprocess.run(args, capture_output=True, text=True, check=True)
        self.assertRegex(success.stdout, r'\A[a-f0-9]{64}\n\Z')
        self.assertEqual(success.stderr, '')
        failure = subprocess.run(args + ['--source-root', str(self.root / 'private-missing')],
                                 capture_output=True, text=True, check=False)
        self.assertNotEqual(failure.returncode, 0)
        self.assertEqual(failure.stdout, '')
        self.assertNotIn(str(self.root), failure.stderr)
        self.assertNotIn('private-missing', failure.stderr)


if __name__ == '__main__':
    unittest.main(verbosity=2)
