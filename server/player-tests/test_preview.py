import functools
import argparse
import importlib.util
from pathlib import Path
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

spec = importlib.util.spec_from_file_location('player_preview', Path(__file__).parents[1] / 'serve-player.py')
preview = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preview)


class PreviewTests(unittest.TestCase):
    def setUp(self):
        self.client = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def test_isolation_mime_and_repository_files_are_not_served(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / 'public'
            root.mkdir()
            (root / 'index.html').write_text('<html lang="zh-CN">游戏</html>', encoding='utf-8')
            (root / 'core.wasm').write_bytes(b'\x00asm\x01\x00\x00\x00')
            (root / '.private').write_text('private')
            (Path(temporary) / 'game.iso').write_bytes(b'private game')
            server = preview.PlayerServer(('127.0.0.1', 0), functools.partial(preview.PlayerHandler, directory=str(root)))
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            base = f'http://127.0.0.1:{server.server_port}'
            try:
                with self.client.open(base + '/', timeout=3) as response:
                    self.assertEqual(response.headers['Cross-Origin-Opener-Policy'], 'same-origin')
                    self.assertEqual(response.headers['Cross-Origin-Embedder-Policy'], 'require-corp')
                    self.assertEqual(response.headers['Content-Security-Policy'],
                                     "connect-src 'self' blob: https:; worker-src 'self' blob:; form-action 'none'; frame-src 'none'")
                    self.assertIn('游戏', response.read().decode())
                with self.client.open(base + '/core.wasm', timeout=3) as response:
                    self.assertEqual(response.headers.get_content_type(), 'application/wasm')
                for path in ['/../game.iso', '/%2e%2e/game.iso', '/.private', '/resources/game.iso']:
                    with self.assertRaises(urllib.error.HTTPError) as error:
                        self.client.open(base + path, timeout=3)
                    self.assertEqual(error.exception.code, 404)
                    error.exception.close()
            finally:
                server.shutdown()
                server.server_close()
                worker.join()

    def test_runtime_https_sources_and_local_test_origins_only_extend_connections(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / 'public'
            root.mkdir()
            (root / 'index.html').write_text('player')
            (Path(temporary) / 'game.iso').write_bytes(b'private game')
            origins = ['http://127.0.0.1:17882', 'http://127.0.0.1:17882']
            server = preview.PlayerServer(('127.0.0.1', 0), functools.partial(
                preview.PlayerHandler, directory=str(root), cdn_origins=origins))
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            base = f'http://127.0.0.1:{server.server_port}'
            try:
                with self.client.open(base + '/', timeout=3) as response:
                    self.assertEqual(response.headers['Content-Security-Policy'],
                                     "connect-src 'self' blob: https: http://127.0.0.1:17882; "
                                     "worker-src 'self' blob:; form-action 'none'; frame-src 'none'")
                    self.assertEqual(response.headers['Cross-Origin-Embedder-Policy'], 'require-corp')
                with self.assertRaises(urllib.error.HTTPError) as error:
                    self.client.open(base + '/resources/game.iso', timeout=3)
                self.assertEqual(error.exception.code, 404)
                error.exception.close()
            finally:
                server.shutdown()
                server.server_close()
                worker.join()

    def test_active_player_rejects_duplicate_listeners(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'index.html').write_text('original player')
            handler = functools.partial(preview.PlayerHandler, directory=str(root))
            with preview.PlayerServer(('127.0.0.1', 0), handler) as server:
                worker = threading.Thread(target=server.serve_forever, daemon=True)
                worker.start()
                try:
                    for server_class in (preview.PlayerServer, ThreadingHTTPServer):
                        with self.subTest(server=server_class.__name__), self.assertRaises(OSError):
                            with server_class(server.server_address, handler):
                                pass
                    with self.client.open(f'http://127.0.0.1:{server.server_port}/', timeout=3) as response:
                        self.assertEqual(response.read(), b'original player')
                finally:
                    server.shutdown()
                    worker.join(timeout=3)
                    self.assertFalse(worker.is_alive())

    def test_stopped_player_allows_rebinding_the_same_port(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            index = root / 'index.html'
            index.write_text('first player')
            handler = functools.partial(preview.PlayerHandler, directory=str(root))
            address = ('127.0.0.1', 0)
            for contents in (b'first player', b'restarted player'):
                index.write_bytes(contents)
                with preview.PlayerServer(address, handler) as server:
                    address = server.server_address
                    worker = threading.Thread(target=server.serve_forever, daemon=True)
                    worker.start()
                    try:
                        with self.client.open(f'http://127.0.0.1:{server.server_port}/', timeout=3) as response:
                            self.assertEqual(response.read(), contents)
                    finally:
                        server.shutdown()
                        worker.join(timeout=3)
                        self.assertFalse(worker.is_alive())

    def test_origin_validation_rejects_paths_credentials_and_csp_injection(self):
        for value in ['*', 'https://*.example', 'https://example/a.iso', 'https://a.example?x=1',
                      'https://a.example#x', 'https://user:pass@a.example', 'ftp://a.example',
                      'https://a.example;script-src', 'https://a.example\nhttps://b.example',
                      "https://a.example'", 'https://a.example:65536', 'https://a.example:',
                      'https://a.example:0', 'https://a..example', 'https://a.example\\path',
                      'http://[fe80::1%zone]', 'https://-a.example']:
            with self.subTest(value=value), self.assertRaises(argparse.ArgumentTypeError):
                preview.cdn_origin(value)
        self.assertEqual(preview.cdn_origin('HTTPS://CDN.EXAMPLE:443/'), 'https://cdn.example')
        self.assertEqual(preview.cdn_origin('http://localhost:17881'), 'http://localhost:17881')
        self.assertEqual(preview.cdn_origin('http://[::1]:17881/'), 'http://[::1]:17881')


if __name__ == '__main__':
    unittest.main()
