#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
# Derived from upstream root-hunter/ppsspp-web (GPL-2.0-or-later; see LICENSE.TXT and UPSTREAM.md), with modifications by CyberNova for PPSSPW (combined with PPSSPW AGPL-3.0-only modules under GPLv3/AGPLv3 Section 13).
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import argparse
import io
import ssl
import os
import subprocess
import threading
import signal
from pathlib import Path
from urllib.parse import unquote, urlparse
from functools import partial


from relay_auth import RelayAuth
from relay import AdhocWebSocketHandler, ThreadingAdhocWebSocketServer, TrackedServerMixin

SERVER_PORT = 27312


class WasmThreadingServer(TrackedServerMixin, ThreadingHTTPServer):
    pass


class WasmThreadingHandler(SimpleHTTPRequestHandler):
    """Publish the packaged player, public assets and named development core outputs."""

    def __init__(self, *args, web_root=None, wasm_root=None, **kwargs):
        self.web_root = os.path.abspath(web_root)
        self.wasm_root = os.path.abspath(wasm_root)
        self.angular_root = os.path.join(self.web_root, "wasm-page", "dist", "ppsspp-web")
        super().__init__(*args, directory=self.web_root, **kwargs)

    def log_request(self, code="-", size="-"):
        self.log_message("%s %s %s", self.command, urlparse(self.path).path, code)

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/adhoc" or path.startswith("/adhoc/"):
            if not getattr(self.server, "adhoc_enabled", False):
                self.send_error(404)
                return
            self.close_connection = True
            relay = object.__new__(AdhocWebSocketHandler)
            relay.request = self.connection
            relay.client_address = self.client_address
            relay.server = self.server
            relay.http_reader = self.rfile
            relay.http_headers = self.headers
            relay.http_path = self.path
            relay.setup()
            try:
                relay.handle()
            finally:
                relay.finish()
            return
        super().do_GET()

    def send_head(self):
        if urlparse(self.path).path == "/healthz":
            body = b'{"status":"ok","relay_protocol":1}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            return io.BytesIO(body)
        self.published_file = self.published_path(self.path)
        if self.published_file is None:
            self.send_error(404)
            return None
        return super().send_head()

    def translate_path(self, path):
        return str(self.published_file)

    def list_directory(self, path):
        self.send_error(404)
        return None

    def published_path(self, url):
        path = unquote(urlparse(url).path).lstrip("/") or "index.html"
        if any(part.startswith(".") for part in path.split("/")) or "\\" in path or "\x00" in path:
            return None
        public = Path(self.web_root, "wasm-page", "public")
        candidates = [(Path(self.angular_root), path), (public, path.removeprefix("wasm-page/public/"))]
        build, sep, asset = path.partition("/")
        if sep and build in ("build-wasm", "build-wasm-release") and (
                asset in ("PPSSPPSDL.js", "PPSSPPSDL.wasm", "PPSSPPSDL.data", "PPSSPPSDL.worker.js")
                or asset.startswith("assets/")):
            candidates.append((Path(self.wasm_root, build), asset))
        for root, relative in candidates:
            candidate = (root / relative).resolve()
            if candidate.is_relative_to(root.resolve()) and candidate.is_file():
                return candidate
        return None

    def end_headers(self):
        self.send_header("Content-Security-Policy", "script-src-attr 'none'")
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        super().end_headers()


def generate_self_signed_cert(cert_file, key_file):
    """Generate a self-signed certificate using openssl."""
    subprocess.run([
        "openssl", "req", "-x509", "-newkey", "rsa:2048",
        "-keyout", key_file, "-out", cert_file,
        "-days", "365", "-nodes",
        "-subj", "/CN=localhost"
    ], check=True)
    print(f"Self-signed certificate generated: {cert_file}, {key_file}", flush=True)


def main():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    web_root = os.path.dirname(script_dir)
    default_wasm_root = os.path.abspath(os.path.join(web_root, "..", "ppsspp-wasm"))
    if not os.path.isdir(default_wasm_root):
        default_wasm_root = web_root

    parser = argparse.ArgumentParser(description="Serve PPSSPP wasm with pthread-compatible headers.")
    parser.add_argument("--bind", "--address", dest="bind", default="192.168.1.170")
    parser.add_argument("--port", type=int, default=8081)
    parser.add_argument("--https", action="store_true", help="Enable HTTPS (TLS)")
    parser.add_argument("--cert", default=None, help="TLS certificate file (PEM)")
    parser.add_argument("--key", default=None, help="TLS private key file (PEM)")
    parser.add_argument("--web-root", default=web_root, help="ppsspp-web checkout root.")
    parser.add_argument("--wasm-root", "--dir", dest="wasm_root", default=default_wasm_root, help="ppsspp-wasm checkout root containing build-wasm/ and build-wasm-release/.")
    parser.add_argument("--adhoc-ws", action="store_true", help="Enable the browser WebSocket ad hoc lobby server.")
    parser.add_argument("--adhoc-ws-port", type=int, default=SERVER_PORT, help="WebSocket ad hoc lobby port.")
    args = parser.parse_args()

    web_root = os.path.abspath(args.web_root)
    wasm_root = os.path.abspath(args.wasm_root)
    handler = partial(WasmThreadingHandler, web_root=web_root, wasm_root=wasm_root)

    server = WasmThreadingServer((args.bind, args.port), handler)

    server.relay_auth = RelayAuth.from_env()
    server.adhoc_enabled = args.adhoc_ws
    if args.https:
        if args.cert is None or args.key is None:
            private_dir = Path.home() / ".local" / "share" / "ppsspw" / "tls"
            private_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
            args.cert = args.cert or str(private_dir / "cert.pem")
            args.key = args.key or str(private_dir / "key.pem")
        if not os.path.isabs(args.cert):
            args.cert = os.path.join(script_dir, args.cert)
        if not os.path.isabs(args.key):
            args.key = os.path.join(script_dir, args.key)
        if os.path.exists(args.cert) != os.path.exists(args.key):
            parser.error("TLS certificate and key must be supplied together")
        if not os.path.exists(args.cert):
            generate_self_signed_cert(args.cert, args.key)
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(certfile=args.cert, keyfile=args.key)
        server.socket = ctx.wrap_socket(server.socket, server_side=True, do_handshake_on_connect=False)
        scheme = "https"
    else:
        ctx = None
        scheme = "http"

    adhoc_server = None
    if args.adhoc_ws:
        adhoc_server = ThreadingAdhocWebSocketServer((args.bind, args.adhoc_ws_port), AdhocWebSocketHandler)
        adhoc_server.relay_auth = server.relay_auth
        if ctx:
            adhoc_server.socket = ctx.wrap_socket(adhoc_server.socket, server_side=True, do_handshake_on_connect=False)
        threading.Thread(target=adhoc_server.serve_forever, name="AdhocWebSocketServer", daemon=True).start()
        print(f"Adhoc WebSocket lobby on {'wss' if ctx else 'ws'}://{args.bind}:{args.adhoc_ws_port}/", flush=True)

    print(f"Serving on {scheme}://{args.bind}:{args.port}/", flush=True)
    print(f"  web root:  {web_root}", flush=True)
    print(f"  wasm root: {wasm_root}", flush=True)
    def stop_signal(signum, frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, stop_signal)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        if adhoc_server:
            adhoc_server.shutdown()
            adhoc_server.server_close()
        with AdhocWebSocketHandler.lobby.lock:
            for user in list(AdhocWebSocketHandler.lobby.users.values()):
                user.handler.stop()
        server.server_close()


if __name__ == "__main__":
    main()
