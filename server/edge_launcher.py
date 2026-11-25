# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of PPSSPW and is licensed under GNU AGPLv3 with Additional Terms (see LICENSE and LICENSE-ADDITIONAL_TERMS-zh-CN.md; ref: LICENSE-ADDITIONAL_TERMS-en.md).
"""Shared graphics-backend window launcher helpers for local PPSSPW previews."""
import io
import ipaddress
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

INTEL_ICD = Path("/usr/share/vulkan/icd.d/intel_icd.json")
NVIDIA_ICD = Path("/usr/share/vulkan/icd.d/nvidia_icd.json")
DEFAULT_BACKEND = "opengl"

BACKENDS = {
    "opengl": {
        "label": "硬件 OpenGL（ANGLE GL · 推荐）",
        "flags": ["--use-gl=angle", "--use-angle=gl"],
        "icd": None,
        "profile_dir": "edge-opengl",
    },
    "webgpu": {
        "label": "WebGPU + GL 合成（Vulkan + Intel 核显）",
        "flags": ["--enable-features=Vulkan", "--use-angle=gl"],
        "icd": "intel-auto",
        "profile_dir": "edge-webgpu",
    },
    "vulkan": {
        "label": "纯 Vulkan 后端（Vulkan + ANGLE Vulkan）",
        "flags": ["--enable-features=Vulkan", "--use-angle=vulkan"],
        "icd": "intel-auto",
        "profile_dir": "edge-vulkan",
    },
    "nvidia": {
        "label": "NVIDIA 独显后端（Vulkan + ANGLE Vulkan）",
        "flags": ["--enable-features=Vulkan", "--use-angle=vulkan"],
        "icd": "nvidia",
        "profile_dir": "edge-nvidia",
    },
    "software": {
        "label": "软件渲染后端（SwiftShader 对照）",
        "flags": ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-webgpu"],
        "icd": None,
        "profile_dir": "edge-software",
    },
}

BROWSER_CANDIDATES = {
    "edge": ("microsoft-edge", "microsoft-edge-stable"),
    "chrome": ("google-chrome",),
    "chromium": ("chromium", "chromium-browser"),
}


def find_browser(preferred="auto"):
    """Find an installed Chromium-family browser executable on Linux desktop."""
    order = (
        ("microsoft-edge", "microsoft-edge-stable", "google-chrome", "chromium", "chromium-browser")
        if preferred == "auto"
        else BROWSER_CANDIDATES.get(preferred, ())
    )
    for name in order:
        found = shutil.which(name)
        if found:
            return found
    return None


def is_loopback_host(bind_host):
    """Return True only when bound strictly to a loopback address."""
    host = str(bind_host or "").strip().strip("[]").lower()
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def edge_launcher_supported(bind_host):
    """Validate host platform, loopback binding, desktop display, and browser availability."""
    return (
        sys.platform == "linux"
        and is_loopback_host(bind_host)
        and bool(os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY"))
        and bool(find_browser())
    )


def has_intel_drm():
    return any(v.read_text().strip() == "0x8086" for v in Path("/sys/class/drm").glob("renderD*/device/vendor"))


def validate_backend_ready(backend):
    """Return an error description if the selected backend cannot run on this machine, else None."""
    if backend not in BACKENDS:
        return f"不支持的图形后端：{backend}"
    icd_mode = BACKENDS[backend]["icd"]
    if icd_mode == "nvidia" and not NVIDIA_ICD.is_file():
        return f"未找到 NVIDIA Vulkan ICD（{NVIDIA_ICD}）"
    return None


def build_launch_env(backend, base_env=None):
    """Prepare isolated subprocess environment variables for a specific GPU backend."""
    env = dict(os.environ if base_env is None else base_env)
    icd_mode = BACKENDS[backend]["icd"]
    # Clear inherited ICD overrides so switching to GL/SwiftShader does not leak Vulkan overrides.
    env.pop("VK_DRIVER_FILES", None)
    env.pop("VK_ICD_FILENAMES", None)
    if icd_mode == "nvidia":
        if NVIDIA_ICD.is_file():
            env["VK_DRIVER_FILES"] = str(NVIDIA_ICD)
    elif icd_mode == "intel-auto":
        if INTEL_ICD.is_file() and (has_intel_drm() or backend == "vulkan"):
            env["VK_DRIVER_FILES"] = str(INTEL_ICD)
    return env


def parse_open_edge_payload(raw_bytes, default_backend=DEFAULT_BACKEND):
    """Parse POST /__local/open-edge request body."""
    if not raw_bytes:
        return default_backend
    text = raw_bytes.decode("utf-8", errors="strict").strip()
    if not text:
        return default_backend
    if not text.startswith("{"):
        raise ValueError("无效的请求负载")
    payload = json.loads(text)
    if not isinstance(payload, dict):
        raise ValueError("请求格式必须为对象")
    backend = str(payload.get("backend") or default_backend).strip()
    if backend not in BACKENDS:
        raise ValueError(f"不支持的图形后端：{backend}")
    return backend


def inject_local_edge_attr(data):
    """Expose data-local-edge on index.html only when --edge-launcher is enabled."""
    return data.replace(b"<html ", b"<html data-local-edge ", 1)


def is_allowed_loopback_request(headers, port, scheme="http"):
    """Strict same-origin and custom-header check for loopback window launch requests."""
    host = headers.get("Host") or ""
    allowed_hosts = {
        f"127.0.0.1:{port}",
        f"localhost:{port}",
        f"[::1]:{port}",
    }
    return (
        host in allowed_hosts
        and headers.get("Origin") == f"{scheme}://{host}"
        and headers.get("Sec-Fetch-Site") == "same-origin"
        and headers.get("X-PPSSPW-Action") == "open-edge"
    )


def send_json(handler, status, payload):
    """Write a UTF-8 JSON response cleanly without extra stack traces."""
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def handle_open_edge_post(handler, root_dir, port, scheme="http"):
    """Validate and spawn an isolated browser window for the requested backend."""
    if handler.path != "/__local/open-edge" or not getattr(handler, "edge_launcher", False):
        return handler.send_error(404)
    if not is_allowed_loopback_request(handler.headers, port, scheme):
        return handler.send_error(403)
    try:
        length = int(handler.headers.get("Content-Length") or "0")
    except ValueError:
        return handler.send_error(400)
    if length < 0 or length > 256:
        return handler.send_error(400)
    raw = handler.rfile.read(length) if length else b""
    try:
        backend = parse_open_edge_payload(raw)
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
        return send_json(handler, 400, {"ok": False, "error": str(exc)})
    err = validate_backend_ready(backend)
    if err:
        return send_json(handler, 400, {"ok": False, "error": err})
    command = [
        sys.executable,
        str(Path(root_dir) / "scripts/open-edge.py"),
        "--port", str(port),
        "--backend", backend,
    ]
    subprocess.Popen(command, cwd=root_dir, stdin=subprocess.DEVNULL, start_new_session=True)
    return send_json(handler, 202, {"ok": True, "backend": backend, "label": BACKENDS[backend]["label"]})


def maybe_serve_local_edge_html(handler, candidate_path, root_dir):
    """Inject data-local-edge into served index.html when --edge-launcher is enabled."""
    if not getattr(handler, "edge_launcher", False) or candidate_path is None:
        return None
    root = Path(root_dir).resolve()
    cand = Path(candidate_path).resolve()
    if cand == root and (root / "index.html").is_file():
        cand = root / "index.html"
    if cand != (root / "index.html"):
        return None
    data = inject_local_edge_attr(cand.read_bytes())
    handler.send_response(200)
    handler.send_header("Content-Type", "text/html; charset=utf-8")
    handler.send_header("Content-Length", str(len(data)))
    handler.end_headers()
    return io.BytesIO(data)

