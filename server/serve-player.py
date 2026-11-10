#!/usr/bin/env python3
"""Serve only the packaged player, with the headers required by Wasm threads."""
import argparse
import functools
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import ipaddress
import os
from pathlib import Path
import re
import socket
import ssl
from urllib.parse import unquote, urlsplit


def cdn_origin(value):
    """Parse one exact CSP origin, never a wildcard or a complete file URL."""
    try:
        if not value or any(char.isspace() or ord(char) < 32 for char in value):
            raise ValueError()
        parts = urlsplit(value)
        if (parts.scheme not in ('https', 'http') or not parts.hostname
                or parts.username is not None or parts.password is not None
                or parts.path not in ('', '/') or '?' in value or '#' in value):
            raise ValueError()
        host = parts.hostname
        if '%' in host:
            raise ValueError()
        if ':' in host:
            host = f'[{ipaddress.IPv6Address(host).compressed}]'
        else:
            host = host.encode('idna').decode('ascii').lower()
            if len(host) > 253 or not re.fullmatch(r'[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?', host):
                raise ValueError()
            if any(not label or len(label) > 63 or label.startswith('-') or label.endswith('-')
                   for label in host.split('.')):
                raise ValueError()
        port = parts.port
        if port == 0 or parts.netloc.endswith(':'):
            raise ValueError()
        suffix = f':{port}' if port is not None and port != {'http': 80, 'https': 443}[parts.scheme] else ''
        return f'{parts.scheme}://{host}{suffix}'
    except (ValueError, UnicodeError):
        raise argparse.ArgumentTypeError('连接来源必须是无路径、凭证和通配符的 http(s) origin') from None


class PlayerHandler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, '.wasm': 'application/wasm',
                      '.js': 'text/javascript; charset=utf-8', '.data': 'application/octet-stream',
                      '.webmanifest': 'application/manifest+json'}

    def __init__(self, *args, cdn_origins=(), **kwargs):
        self.cdn_origins = tuple(dict.fromkeys(cdn_origins))
        super().__init__(*args, **kwargs)

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
        connections = "'self' blob: https:" + ''.join(f' {origin}' for origin in self.cdn_origins)
        self.send_header('Content-Security-Policy', f"connect-src {connections}; worker-src 'self' blob:; form-action 'none'; frame-src 'none'")
        super().end_headers()


class PlayerServer(ThreadingHTTPServer):
    """Allow prompt restarts without sharing a live listener's address."""

    allow_reuse_address = os.name != 'nt'
    allow_reuse_port = False

    def server_bind(self):
        if os.name == 'nt':
            # Windows SO_REUSEADDR permits a second server to steal requests.
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def main():
    parser = argparse.ArgumentParser(description='本地预览中文游戏入口，不提供仓库目录访问。')
    parser.add_argument('--bind', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=17881)
    parser.add_argument('--cert', type=Path, help='移动设备访问需要受信任的 HTTPS 证书')
    parser.add_argument('--key', type=Path)
    parser.add_argument('--connect-origin', '--cdn-origin', dest='connect_origins',
                        action='append', default=[], type=cdn_origin,
                        help='额外允许的连接 origin，可重复；默认允许 HTTPS，用于本地 HTTP 测试')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1] / 'wasm-page/dist/ppsspp-web'
    if not (root / 'index.html').is_file():
        parser.error('请先执行 pnpm --dir wasm-page run build:pages')
    if bool(args.cert) != bool(args.key):
        parser.error('--cert 与 --key 必须同时提供')
    server = PlayerServer((args.bind, args.port), functools.partial(
        PlayerHandler, directory=str(root), cdn_origins=args.connect_origins))
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
