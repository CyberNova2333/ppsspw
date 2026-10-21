#!/usr/bin/env python3
"""Serve only the packaged player, with the headers required by Wasm threads."""
import argparse
import functools
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import ssl
from urllib.parse import unquote, urlsplit


class PlayerHandler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, '.wasm': 'application/wasm',
                      '.js': 'text/javascript; charset=utf-8', '.data': 'application/octet-stream',
                      '.webmanifest': 'application/manifest+json'}

    def list_directory(self, path):
        self.send_error(404)
        return None

    def send_head(self):
        parts = Path(unquote(urlsplit(self.path).path)).parts
        candidate = Path(self.translate_path(self.path)).resolve()
        root = Path(self.directory).resolve()
        if any(part.startswith('.') for part in parts) or not candidate.is_relative_to(root):
            self.send_error(404)
            return None
        return super().send_head()

    def end_headers(self):
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        self.send_header('Cross-Origin-Resource-Policy', 'same-origin')
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Content-Security-Policy', "connect-src 'self' blob:; form-action 'none'; frame-src 'none'")
        super().end_headers()


def main():
    parser = argparse.ArgumentParser(description='本地预览中文游戏入口，不提供仓库目录访问。')
    parser.add_argument('--bind', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=17881)
    parser.add_argument('--cert', type=Path, help='移动设备访问需要受信任的 HTTPS 证书')
    parser.add_argument('--key', type=Path)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1] / 'wasm-page/dist/ppsspp-web'
    if not (root / 'index.html').is_file():
        parser.error('请先执行 npm --prefix wasm-page run build:pages')
    if bool(args.cert) != bool(args.key):
        parser.error('--cert 与 --key 必须同时提供')
    server = ThreadingHTTPServer((args.bind, args.port), functools.partial(PlayerHandler, directory=str(root)))
    if args.cert:
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(args.cert, args.key)
        server.socket = context.wrap_socket(server.socket, server_side=True)
    print(f"Player: {'https' if args.cert else 'http'}://{args.bind}:{args.port}/", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
