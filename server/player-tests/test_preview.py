import functools
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
    def test_isolation_mime_and_repository_files_are_not_served(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / 'public'
            root.mkdir()
            (root / 'index.html').write_text('<html lang="zh-CN">游戏</html>', encoding='utf-8')
            (root / 'core.wasm').write_bytes(b'\x00asm\x01\x00\x00\x00')
            (root / '.private').write_text('private')
            (Path(temporary) / 'game.iso').write_bytes(b'private game')
            server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(preview.PlayerHandler, directory=str(root)))
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            base = f'http://127.0.0.1:{server.server_port}'
            try:
                with urllib.request.urlopen(base + '/') as response:
                    self.assertEqual(response.headers['Cross-Origin-Opener-Policy'], 'same-origin')
                    self.assertEqual(response.headers['Cross-Origin-Embedder-Policy'], 'require-corp')
                    self.assertIn('游戏', response.read().decode())
                with urllib.request.urlopen(base + '/core.wasm') as response:
                    self.assertEqual(response.headers.get_content_type(), 'application/wasm')
                for path in ['/../game.iso', '/%2e%2e/game.iso', '/.private', '/resources/game.iso']:
                    with self.assertRaises(urllib.error.HTTPError) as error:
                        urllib.request.urlopen(base + path)
                    self.assertEqual(error.exception.code, 404)
                    error.exception.close()
            finally:
                server.shutdown()
                server.server_close()
                worker.join()


if __name__ == '__main__':
    unittest.main()
