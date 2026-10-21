import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest


spec = importlib.util.spec_from_file_location(
    'game_manifest', Path(__file__).parents[2] / 'scripts/create-game-manifest.py')
manifest = importlib.util.module_from_spec(spec)
spec.loader.exec_module(manifest)


class ManifestTests(unittest.TestCase):
    def test_cli_hashes_all_chunks_and_partial_tail_without_copying_input(self):
        payload = bytes(range(256)) * 513
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            game = root / '游戏.iso'
            game.write_bytes(payload)
            output = root / 'publish/game.json'
            with contextlib.redirect_stdout(io.StringIO()):
                manifest.main([str(game), '--id', 'test-zh', '--chunk-size', '65536',
                               '--source', 'https://cdn.example/game.iso',
                               '--source', 'https://mirror.example/game.iso?revision=1',
                               '--output', str(output)])
            result = json.loads(output.read_text(encoding='utf-8'))
            self.assertEqual(result['schemaVersion'], 1)
            self.assertEqual(result['id'], 'test-zh')
            self.assertEqual(result['name'], '游戏.iso')
            self.assertEqual(result['size'], len(payload))
            self.assertEqual(result['chunkSize'], 65536)
            self.assertEqual(result['sha256'], [hashlib.sha256(payload[offset:offset + 65536]).hexdigest()
                                               for offset in range(0, len(payload), 65536)])
            self.assertEqual(result['fileSha256'], hashlib.sha256(payload).hexdigest())
            self.assertEqual(result['sources'], ['https://cdn.example/game.iso',
                                                 'https://mirror.example/game.iso?revision=1'])
            self.assertNotIn(str(root), output.read_text(encoding='utf-8'))
            self.assertEqual(game.read_bytes(), payload)
            with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
                manifest.main([str(game), '--id', 'test', '--source', 'https://cdn.example/game.iso',
                               '--output', str(output)])
            self.assertEqual(json.loads(output.read_text(encoding='utf-8')), result)

    def test_empty_files_bad_sizes_names_and_ids_are_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            game = Path(temporary) / 'game.iso'
            game.write_bytes(b'')
            with self.assertRaises(ValueError):
                manifest.create_manifest(game, 'test', ['https://cdn.example/game.iso'])
            game.write_bytes(b'game')
            for args in [dict(game_id='../escape'), dict(game_id='x' * 65), dict(chunk_size=0),
                         dict(chunk_size=65535), dict(chunk_size=16777217), dict(name='../game.iso'),
                         dict(name='a\\game.iso'), dict(name='a:game.iso'), dict(name='game.zip'),
                         dict(sources=[]), dict(sources=['https://cdn.example/a'] * 7)]:
                inputs = dict(path=game, game_id='test', sources=['https://cdn.example/game.iso'])
                inputs.update(args)
                with self.subTest(args=args), self.assertRaises(ValueError):
                    manifest.create_manifest(**inputs)

    def test_sources_require_https_except_loopback_and_never_include_credentials(self):
        for url in ['http://cdn.example/a.iso', 'https://user:pass@cdn.example/a.iso',
                    'https://cdn.example/a.iso#fragment', 'data:game', 'file:///game.iso',
                    'https://cdn.example:65536/game.iso', 'https://cdn.example/a\nb.iso',
                    'https://cdn.example\\other/game.iso', 'https://cdn.example:/a.iso',
                    'https://%ff/a.iso', 'https://*.example/a.iso', 'https://a..example/a.iso']:
            with self.subTest(url=url), self.assertRaises(ValueError):
                manifest.source_url(url)
        for url in ['http://localhost:10000/game.iso', 'http://127.0.0.1:10000/game.iso',
                    'http://[::1]:10000/game.iso', 'https://cdn.example/game.iso?q=1']:
            self.assertEqual(manifest.source_url(url), url)

    def test_manifest_larger_than_client_limit_is_not_written(self):
        with tempfile.TemporaryDirectory() as temporary:
            game = Path(temporary) / 'game.iso'
            game.write_bytes(b'game')
            output = Path(temporary) / 'manifest.json'
            oversized_url = 'https://cdn.example/game.iso?q=' + 'x' * manifest.MAX_MANIFEST_SIZE
            with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
                manifest.main([str(game), '--id', 'test', '--source', oversized_url, '--output', str(output)])
            self.assertFalse(output.exists())


if __name__ == '__main__':
    unittest.main()
