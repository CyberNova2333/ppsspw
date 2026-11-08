/*
 * Copyright (c) 2026 Antonio Ricciardi
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

// Some privacy modes throw even when reading localStorage. Preferences are
// optional; keep the emulator usable for the current tab when storage is denied.
const preferences = (() => {
  const fallback = new Map();
  return {
    getItem(key) { if (fallback.has(key)) return fallback.get(key); try { return localStorage.getItem(key); } catch (_) { return null; } },
    setItem(key, value) { fallback.set(key, String(value)); try { localStorage.setItem(key, String(value)); } catch (_) {} },
    removeItem(key) { fallback.set(key, null); try { localStorage.removeItem(key); } catch (_) {} },
  };
})();

/* ── Constants ──────────────────────────────────────────────────── */
let BUILD_DIR          = "build-wasm/";
let BUILD_STAMP        = String(Date.now());
let performanceLaunchSettings = null;
let performanceBuildInfo = null;
let ASSET_DIR          = BUILD_DIR + "assets/";
const MANIFEST         = "assets-manifest.txt";
const USE_PRELOADED_ASSETS = true;
const VIRTUAL_ASSETS   = "/emsdk/upstream/emscripten/cache/sysroot/share/ppsspp/assets";
const VIRTUAL_GAME_DIR = "/browser-games";
const GAME_FILE_ACCEPT = ".iso,.cso,.chd,.pbp,.elf,.prx";
const GAME_FILE_EXT_RE = /\.(iso|cso|chd|pbp|elf|prx)$/i;
// Cloud saves and multiplayer stay disabled. User-supplied download manifests
// are handled separately by the download panel.
const LOCAL_ONLY = true;
const PLAYER_SETTINGS_KEY = "ppsspp-player-settings-v1";

function gameFileValidationError(fileOrName) {
  if (!fileOrName) return "";
  const name = typeof fileOrName === "string" ? fileOrName : fileOrName.name;
  if (typeof name === "string" && GAME_FILE_EXT_RE.test(name)) return "";
  if (/\.(zip|7z|rar|tar|gz)$/i.test(name || "")) return "请先解压游戏压缩包，再选择其中的 ISO、CSO、CHD 或 PBP 游戏文件。";
  return "不支持此文件格式。请选择 ISO、CSO、CHD、PBP、ELF 或 PRX 游戏文件。";
}

function validateGameSelection(fileOrName) {
  const error = gameFileValidationError(fileOrName);
  if (!error) return true;
  setStatus(error, "err");
  showToast(error, 6500);
  return false;
}

// Persistence: PPSSPP writes config+saves to $HOME/.config/ppsspp/ on Linux/Emscripten
const PERSIST_ROOTS       = ["/home/web_user/.config/ppsspp", "/root/.config/ppsspp"];
const OPFS_ROOT_DIR       = "ppsspp-web";
const OPFS_PERSIST_DIR    = "persist";
const OPFS_GAMES_DIR      = "games";
const OPFS_GAME_META_DIR  = "game-meta";
const PERSIST_SYNC_MS     = 30000; // auto-sync every 30 s
const MOBILE_EMULATOR_ARGS = ["--dpi", "1", "--xres", "1280", "--yres", "720"];
const WEB_NATIVE_TIMING_CONFIG = [
  ["General", "ForceLagSync2", "True"],
  ["Graphics", "DisplayRefreshRate", "60"],
  ["Graphics", "FrameRate", "0"],
  ["Graphics", "FrameRate2", "-1"],
  ["Graphics", "FrameSkip", "0"],
  ["Graphics", "AutoFrameSkip", "False"],
  ["Graphics", "VerticalSync", "True"],
  ["Graphics", "LowLatencyPresent", "False"],
  ["Sound", "Enable", "True"],
  ["Sound", "ExtraAudioBuffering", "False"],
  ["Sound", "AudioBufferSize", "1024"],
  ["Sound", "FillAudioGaps", "True"],
  ["Sound", "AudioSyncMode", "0"],
];
const WEB_STABILITY_CONFIG = [
  ["General", "IgnoreBadMemAccess", "True"],
  ["CPU", "FastMemoryAccess", "True"],
];
const MOBILE_TOUCH_CONFIG = [
  ["General", "UIScaleFactor", "0"],
  ["Control", "ShowTouchControls", "False"],
  ["Control", "TouchButtonStyle", "1"],
  ["Control", "TouchButtonOpacity", "78"],
  ["Control", "TouchButtonHideSeconds", "0"],
  ["Control", "TouchGliding", "True"],
  ["TouchControls.Landscape", "ShowTouchCross", "True"],
  ["TouchControls.Landscape", "ShowTouchCircle", "True"],
  ["TouchControls.Landscape", "ShowTouchSquare", "True"],
  ["TouchControls.Landscape", "ShowTouchTriangle", "True"],
  ["TouchControls.Landscape", "ShowTouchDpad", "True"],
  ["TouchControls.Landscape", "ShowAnalogStick", "True"],
  ["TouchControls.Landscape", "ShowTouchStart", "True"],
  ["TouchControls.Landscape", "ShowTouchSelect", "True"],
  ["TouchControls.Landscape", "ShowTouchLTrigger", "True"],
  ["TouchControls.Landscape", "ShowTouchRTrigger", "True"],
  ["TouchControls.Landscape", "ShowTouchPause", "True"],
  ["TouchControls.Landscape", "ActionButtonScale", "1.0"],
  ["TouchControls.Landscape", "DPadScale", "1.0"],
  ["TouchControls.Landscape", "AnalogStickScale", "1.0"],
  ["TouchControls.Landscape", "StartKeyScale", "1.0"],
  ["TouchControls.Landscape", "SelectKeyScale", "1.0"],
  ["TouchControls.Landscape", "UnthrottleKeyScale", "1.0"],
  ["TouchControls.Landscape", "LKeyScale", "1.0"],
  ["TouchControls.Landscape", "RKeyScale", "1.0"],
  ["TouchControls.Landscape", "PauseKeyScale", "1.0"],
  ["TouchControls.Landscape", "ActionButtonSpacing2", "1.0"],
  ["TouchControls.Landscape", "DPadSpacing", "1.0"],
  ["TouchControls.Landscape", "LeftStickHeadScale", "1.0"],
  ["TouchControls.Portrait", "ShowTouchCross", "True"],
  ["TouchControls.Portrait", "ShowTouchCircle", "True"],
  ["TouchControls.Portrait", "ShowTouchSquare", "True"],
  ["TouchControls.Portrait", "ShowTouchTriangle", "True"],
  ["TouchControls.Portrait", "ShowTouchDpad", "True"],
  ["TouchControls.Portrait", "ShowAnalogStick", "True"],
  ["TouchControls.Portrait", "ShowTouchStart", "True"],
  ["TouchControls.Portrait", "ShowTouchSelect", "True"],
  ["TouchControls.Portrait", "ShowTouchLTrigger", "True"],
  ["TouchControls.Portrait", "ShowTouchRTrigger", "True"],
  ["TouchControls.Portrait", "ShowTouchPause", "True"],
  ["TouchControls.Portrait", "ActionButtonScale", "1.0"],
  ["TouchControls.Portrait", "DPadScale", "1.0"],
  ["TouchControls.Portrait", "AnalogStickScale", "1.0"],
  ["TouchControls.Portrait", "StartKeyScale", "1.0"],
  ["TouchControls.Portrait", "SelectKeyScale", "1.0"],
  ["TouchControls.Portrait", "UnthrottleKeyScale", "1.0"],
  ["TouchControls.Portrait", "LKeyScale", "1.0"],
  ["TouchControls.Portrait", "RKeyScale", "1.0"],
  ["TouchControls.Portrait", "PauseKeyScale", "1.0"],
  ["TouchControls.Portrait", "ActionButtonSpacing2", "1.0"],
  ["TouchControls.Portrait", "DPadSpacing", "1.0"],
  ["TouchControls.Portrait", "LeftStickHeadScale", "1.0"],
];

// Google Drive is client-side only: OAuth Web client IDs are public by design.
const GOOGLE_CLIENT_ID_KEY = "ppsspp_google_client_id";
const GOOGLE_TOKEN_KEY = "ppsspp_google_token";
const GOOGLE_OAUTH_STATE_KEY = "ppsspp_google_oauth_state";
const GOOGLE_PENDING_ACTION_KEY = "ppsspp_google_pending_action";
const GOOGLE_DRIVE_APP_ROOT = "PPSSPP Web";
const GOOGLE_DRIVE_SAVE_BUNDLE = "ppsspp-saves.ppsspp";
const GOOGLE_DRIVE_SCOPE = [
  "https://www.googleapis.com/auth/drive.file",
].join(" ");
const GOOGLE_GIS_SRC = "https://accounts.google.com/gsi/client";
const GOOGLE_AUTH_TIMEOUT_MS = 90000;
const GOOGLE_AUTO_SYNC_KEY      = "ppsspp_drive_autosync";      // "1" / "0"
const GOOGLE_AUTO_SYNC_RATE_KEY = "ppsspp_drive_autosync_rate"; // seconds
const NETWORK_ENABLE_KEY = "ppsspp_network_enable";
const NETWORK_SERVER_KEY = "ppsspp_network_server";
const NETWORK_NICK_KEY   = "ppsspp_network_nick";
const NETWORK_MAC_KEY    = "ppsspp_network_mac";
const PRELOAD_FAVORITES_KEY = "ppsspp_preload_favorites";
const PRELOAD_FAVORITES_MIGRATED_KEY = "ppsspp_preload_favorites_migrated_v1";
const PRELOAD_DEFAULTS_APPLIED_KEY = "ppsspp_preload_defaults_applied_v1";
const ADHOC_WS_PORT      = 27312;

let stableViewportWidth = 0;
let stableViewportHeight = 0;
let stableViewportOrientation = "";

function fullscreenElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}

function viewportOrientation(width = window.innerWidth || 0, height = window.innerHeight || 0) {
  return width >= height ? "landscape" : "portrait";
}

function isTextEntryActive() {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  return el.isContentEditable || tag === "TEXTAREA"
    || (tag === "INPUT" && /^(text|search|url|tel|email|password|number)$/.test(el.type || "text"));
}

function configureEmulatorKeyboard(env) {
  // SDL otherwise listens on window and prevents the form's default key actions.
  env.SDL_EMSCRIPTEN_KEYBOARD_ELEMENT = "#canvas";
  // The core derives its memory-stick path from these variables. Use one
  // authoritative root; legacy /root files are migrated before native startup.
  env.HOME = "/home/web_user";
  env.XDG_CONFIG_HOME = "/home/web_user/.config";
}

function syncViewportAfterFocus() {
  syncViewportSize({ reset: false });
  setTimeout(() => {
    syncViewportSize({ reset: false });
  }, 260);
}

function revealPanelInput() {
  const input = document.activeElement;
  const scroller = input?.closest?.("#sidePanel .tab-panel.active");
  if (!scroller || !isTextEntryActive()) return;
  const field = input.getBoundingClientRect();
  const bounds = scroller.getBoundingClientRect();
  // Scroll only the section: scrolling the page can pan the viewport on iOS.
  if (field.bottom > bounds.bottom - 16) {
    scroller.scrollTop += field.bottom - bounds.bottom + 16;
  } else if (field.top < bounds.top + 16) {
    scroller.scrollTop += field.top - bounds.top - 16;
  }
}

function syncViewportSize(options = {}) {
  const reset = options?.reset === true;
  const vv = window.visualViewport;
  const activeFullscreen = !!fullscreenElement();
  const visualWidth = Math.round(vv?.width || window.innerWidth || document.documentElement.clientWidth || 0);
  const visualHeight = Math.round(vv?.height || window.innerHeight || document.documentElement.clientHeight || 0);
  const layoutWidth = Math.round(window.innerWidth || document.documentElement.clientWidth || visualWidth);
  const layoutHeight = Math.round(window.innerHeight || document.documentElement.clientHeight || visualHeight);
  // CSS layout and pointer client coordinates stay in layout-viewport pixels.
  // Pinch zoom changes the visual viewport, not the width of the application.
  const width = Math.max(1, layoutWidth || visualWidth);
  // The keyboard can make a portrait visual viewport wider than it is tall.
  const orientation = window.screen?.orientation?.type?.split("-")[0]
    || viewportOrientation(layoutWidth, stableViewportHeight || layoutHeight);
  const orientationChanged = stableViewportOrientation && stableViewportOrientation !== orientation;
  let widthChanged = !stableViewportWidth || Math.abs(width - stableViewportWidth) > 1;
  if (reset || orientationChanged) {
    stableViewportWidth = 0;
    stableViewportHeight = 0;
    widthChanged = true;
  }
  stableViewportOrientation = orientation;
  const safeVisualHeight = Math.max(1, visualHeight || layoutHeight || 320);
  const safeLayoutHeight = Math.max(1, layoutHeight || safeVisualHeight);

  if (widthChanged) {
    stableViewportWidth = width;
    stableViewportHeight = Math.max(safeVisualHeight, safeLayoutHeight);
  }

  const unzoomedVisualHeight = safeVisualHeight * Math.max(1, vv?.scale || 1);
  const keyboardOpen = isTextEntryActive() && stableViewportHeight && unzoomedVisualHeight < stableViewportHeight * 0.82;
  if (!keyboardOpen) {
    stableViewportHeight = Math.max(safeVisualHeight, safeLayoutHeight);
  }

  document.body?.classList.toggle("keyboard-open", keyboardOpen);
  document.body?.classList.toggle("browser-fullscreen", activeFullscreen);
  const appHeight = activeFullscreen ? Math.max(1, safeLayoutHeight || safeVisualHeight) : Math.max(1, stableViewportHeight || safeVisualHeight);
  document.documentElement.style.setProperty("--viewport-w", width + "px");
  document.documentElement.style.setProperty("--app-h", appHeight + "px");
  document.documentElement.style.setProperty("--visual-h", safeVisualHeight + "px");
  document.documentElement.style.setProperty("--visual-top", Math.max(0, vv?.offsetTop || 0) + "px");
  document.documentElement.style.setProperty("--visual-left", Math.max(0, vv?.offsetLeft || 0) + "px");
  revealPanelInput();
}

function syncFullscreenOverlays() {
  const activeFullscreen = !!fullscreenElement();
  document.body?.classList.toggle("browser-fullscreen", activeFullscreen);
  if (activeFullscreen && fpsBadge) fpsBadge.style.display = "none";
  if (fullscreenBtn) {
    fullscreenBtn.title = activeFullscreen ? "退出全屏" : isMobileExperience() ? "横屏全屏游玩" : "进入全屏";
    fullscreenBtn.setAttribute("aria-label", fullscreenBtn.title);
    fullscreenBtn.setAttribute("aria-pressed", String(activeFullscreen));
  }
}

function notifyRuntimeResize(options = {}) {
  syncViewportSize(options);
  window.dispatchEvent(new Event("resize"));
}

function scheduleRuntimeResize(reset = false) {
  [0, 60, 140, 300, 650].forEach((delay, index) => {
    setTimeout(() => notifyRuntimeResize({ reset: reset && index === 0 }), delay);
  });
}

function canvasLayoutSnapshot(element) {
  const rect = element?.getBoundingClientRect();
  if (!rect || rect.width <= 0 || rect.height <= 0) return null;
  return [rect.left, rect.top, rect.width, rect.height, window.devicePixelRatio || 1];
}

function installCanvasResizeTracking(element) {
  if (!element) return () => {};
  let previous = canvasLayoutSnapshot(element);
  let frame = null;
  let disposed = false;
  const measure = () => {
    frame = null;
    if (disposed) return;
    const current = canvasLayoutSnapshot(element);
    const old = previous;
    previous = current;
    if (!current) {
      if (old) document.dispatchEvent(new Event("ppsspp-player-layout"));
      return;
    }
    if (old && current.every((value, index) => value === old[index])) return;
    // Cancel gestures tied to the old geometry before the next interaction.
    document.dispatchEvent(new Event("ppsspp-player-layout"));
    if (!old || current.slice(2).some((value, index) => value !== old[index + 2])) {
      // SDL listens for window resize, but CSS-only drawer/viewport changes
      // also resize its canvas. Notify only after layout has actually settled.
      notifyRuntimeResize();
    }
  };
  const schedule = () => {
    if (!disposed && frame === null) frame = requestAnimationFrame(measure);
  };
  let resolutionQuery = null;
  const watchResolution = () => {
    resolutionQuery?.removeEventListener?.("change", resolutionChanged);
    resolutionQuery = window.matchMedia?.(`(resolution: ${window.devicePixelRatio || 1}dppx)`) || null;
    resolutionQuery?.addEventListener?.("change", resolutionChanged);
  };
  const resolutionChanged = () => { watchResolution(); schedule(); };
  watchResolution();
  const events = [
    [window, "resize"], [window.visualViewport, "resize"], [window.visualViewport, "scroll"],
    [document, "scroll"], [document, "fullscreenchange"], [document, "webkitfullscreenchange"],
  ];
  for (const [target, type] of events) target?.addEventListener(type, schedule, { capture: true, passive: true });
  const observer = typeof window.ResizeObserver === "function" ? new window.ResizeObserver(schedule) : null;
  observer?.observe(element);
  if (element.parentElement) observer?.observe(element.parentElement);
  // A drawer/class/style change can move the canvas without resizing either
  // observed box. Watch only its owning elements, not the whole document tree.
  const layoutObserver = typeof window.MutationObserver === "function" ? new window.MutationObserver(schedule) : null;
  layoutObserver?.observe(element, { attributes: true, attributeFilter: ["class", "style"] });
  if (element.parentElement) layoutObserver?.observe(element.parentElement, { attributes: true, attributeFilter: ["class", "style"] });
  if (document.body) layoutObserver?.observe(document.body, { attributes: true, attributeFilter: ["class"] });
  return () => {
    disposed = true;
    if (frame !== null) cancelAnimationFrame(frame);
    observer?.disconnect();
    layoutObserver?.disconnect();
    resolutionQuery?.removeEventListener?.("change", resolutionChanged);
    for (const [target, type] of events) target?.removeEventListener(type, schedule, true);
  };
}

function emulatorLaunchArgs() {
  return isMobileExperience() ? MOBILE_EMULATOR_ARGS.slice() : [];
}

function isMobileExperience() {
  return !!window.matchMedia?.("(pointer: coarse)")?.matches;
}

syncViewportSize({ reset: true });
window.addEventListener("resize", () => syncViewportSize({ reset: false }), { passive: true });
window.addEventListener("orientationchange", () => scheduleRuntimeResize(true), { passive: true });
window.screen?.orientation?.addEventListener?.("change", () => scheduleRuntimeResize(true));
window.visualViewport?.addEventListener("resize", () => syncViewportSize({ reset: false }), { passive: true });
window.visualViewport?.addEventListener("scroll", () => syncViewportSize({ reset: false }), { passive: true });
document.addEventListener("focusin", syncViewportAfterFocus);
document.addEventListener("focusout", () => setTimeout(() => syncViewportSize({ reset: false }), 120));

function setBuildDir(dir) {
  BUILD_DIR = dir;
  ASSET_DIR = BUILD_DIR + "assets/";
}

async function hasBuildFile(dir, name) {
  try {
    const r = await fetch(dir + name + "?v=" + BUILD_STAMP, { method: "HEAD", cache: "no-store" });
    return r.ok;
  } catch(e) {
    try { return !!(await caches.match(new URL(dir + name, location.href).href, { ignoreSearch: true })); }
    catch (_) { return false; }
  }
}

async function selectBuildDir() {
  let packagedRevision = "";
  performanceBuildInfo = null;
  try {
    const response = await fetch("build-info.json", { cache: "no-store" });
    if (response.ok) {
      const info = await response.json();
      if (/^[a-f0-9]{64}$/.test(info.revision)) {
        packagedRevision = info.revision;
        performanceBuildInfo = info.resources || null;
      }
    }
  } catch (_) { /* Development servers may not publish build metadata. */ }
  // A packaged revision describes build-wasm only. Never mix it with a local
  // release directory that may contain an older, incompatible core.
  const dirs = packagedRevision ? ["build-wasm/"] : ["build-wasm-release/", "build-wasm/"];
  if (packagedRevision) BUILD_STAMP = packagedRevision;
  for (const dir of dirs) {
    const available = await Promise.all(["PPSSPPSDL.js", "PPSSPPSDL.wasm", "PPSSPPSDL.data"].map(name => hasBuildFile(dir, name)));
    if (!available.every(Boolean)) continue;
    setBuildDir(dir);
    log("Using emulator build: " + BUILD_DIR, "ok");
    return;
  }
  throw new Error("模拟器资源不完整，请重新载入页面；若仍失败，请在错误详情中导出诊断。");
}

/* ── DOM refs ───────────────────────────────────────────────────── */
/* ── Lucide SVG helper (for dynamically injected HTML) ──────────── */
const LUCIDE_PATHS = {
  play:     '<polygon points="5 3 19 12 5 21 5 3"/>',
  pause:    '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  upload:   '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
  trash:    '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>',
  save:     '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>',
  gamepad:  '<line x1="6" y1="11" x2="10" y2="11"/><line x1="8" y1="9" x2="8" y2="13"/><line x1="15" y1="12" x2="15.01" y2="12"/><line x1="17" y1="10" x2="17.01" y2="10"/><path d="M6 3h12l2 7-6 3-2 3-2-3-6-3z"/>',
  info:           '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
  menu:           '<line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="18" x2="20" y2="18"/>',
  preload:        '<path d="M10 16h.01"/><path d="M2.212 11.577a2 2 0 0 0-.212.896V18a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-5.527a2 2 0 0 0-.212-.896L18.55 5.11A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><path d="M21.946 12.013H2.054"/><path d="M6 16h.01"/>',
  'cloud-upload': '<path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/><path d="M12 12v9"/><path d="m16 16-4-4-4 4"/>',
};
function svgIcon(name, cls = "lucide") {
  const d = LUCIDE_PATHS[name] || "";
  return `<svg class="${cls}" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
}

function triggerDownload(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

const byId = id => document.getElementById(id);
function on(target, type, handler, options) {
  const el = typeof target === "string" ? byId(target) : target;
  if (!el) {
    console.warn("PPSSPW: missing DOM element for listener", target);
    return null;
  }
  el.addEventListener(type, handler, options);
  return el;
}

const canvas          = byId("canvas");
installCanvasResizeTracking(canvas);
let touchControlState = null, touchControlMount = null;
let touchControlsInitialized = false, touchControlsVisible = false, touchControlError = "";
let gamepadBridgeInstalled = false, gamepadBridgeCurrent = null, gamepadBridgeMode = "";
let gamepadBridgeRawIndex = -1;
const stageEl         = document.querySelector(".stage");
const fileInput       = byId("gameFile");
const fileLabel       = byId("fileLabel");
const runtimeGameLabel = byId("runtimeIsoLabel") || byId("runtimeGameLabel");
const runtimeGameInput = byId("runtimeIsoFile") || byId("runtimeGameFile");
const startBtn        = byId("startBtn");
const fullscreenBtn   = byId("fullscreenBtn");
const statusEl        = byId("statusText");
const statusDot       = byId("statusDot");
const stageDotEl      = byId("stageDot");
const stageMiniTextEl = byId("stageMiniText");
const logEl           = byId("log");
const logFilter       = byId("logFilter");
const loadOverlay     = byId("loadOverlay");
const loadLabel       = byId("loadLabel");
[fileInput, runtimeGameInput, byId("libraryImportFile")]
  .filter(Boolean)
  .forEach(input => { input.accept = GAME_FILE_ACCEPT; });
const progressBar     = byId("progressBar");
const idleOverlay     = byId("idleOverlay");
const idleSubtitle    = byId("idleSubtitle");
const idleStartBtn    = byId("idleStartBtn");
const fpsBadge        = byId("fpsBadge");
const gpuBadge        = byId("gpuBadge");
const gamepadBadge    = byId("gamepadBadge");
const gamepadSelect   = byId("gamepadSelect");
const gpuSelectEl     = byId("gpuSelect");
const panelToggleBtn  = byId("panelToggleBtn");
const googleClientIdInput = byId("googleClientIdInput");
const driveAuthEl     = byId("iDriveAuth");
const driveFolderEl   = byId("iDriveFolder");
const driveRemoteEl   = byId("iDriveRemote");
const driveActivityEl = byId("driveActivity");
const driveRemoteList = byId("driveRemoteList");
const driveBadgeEl    = byId("driveBadge");
const driveBadgeText  = byId("driveBadgeText");
let networkSessionKey = "";
const networkEnableToggle = byId("networkEnableToggle");
const networkServerInput  = byId("networkServerInput");
const networkNickInput    = byId("networkNickInput");
const networkMacInput     = byId("networkMacInput");
let networkDraftDirty = false;
let networkLiveStatus = null;
let networkActiveConfig = null;
let networkProbe = { state: "unverified" };
const networkTestBtn      = byId("networkTestBtn");
const networkSaveBtn      = byId("networkSaveBtn");
const networkActivityEl   = byId("networkActivity");

// Panel toggle (hidden by default; restore from localStorage)
const PANEL_KEY = "ppsspp_panel_open";
function setPanelOpen(open, focus = true) {
  document.body.classList.toggle("panel-open", open);
  if (open) setFullscreenMenuOpen(false, false);
  const stage = document.querySelector(".stage");
  if (stage) stage.inert = open;
  preferences.setItem(PANEL_KEY, open ? "1" : "0");
  if (open) checkNetworkWhenVisible();
  for (const id of ["panelToggleBtn", "fsPanelBtn"]) byId(id)?.setAttribute("aria-expanded", String(open));
  if (focus) {
    const target = open ? byId("panelCloseBtn") : fullscreenElement() ? byId("fsMenuToggle") : panelToggleBtn;
    target?.focus({ preventScroll: true });
  }
  updateTouchControls();
}
// A saved desktop drawer should not cover the game on the next mobile visit.
setPanelOpen(!isMobileExperience() && preferences.getItem(PANEL_KEY) === "1", false);
on(panelToggleBtn, "click", () => {
  setPanelOpen(!document.body.classList.contains("panel-open"));
});
on("panelCloseBtn", "click", () => setPanelOpen(false));
on("panelBackdrop", "click", () => setPanelOpen(false));

if (!LOCAL_ONLY) importNetworkInvite();
updateNetworkConfigUI();
window.PPSSPPNetworkInvites = {
  create(includeKey = false) {
    const cfg = saveNetworkConfigFromUI();
    const url = new URL(location.href);
    url.search = "";
    url.hash = new URLSearchParams({ relay: cfg.server, room: cfg.room,
      ...(includeKey && cfg.sessionKey ? { session_key: cfg.sessionKey } : {}) }).toString();
    return url.href;
  },
  import(value) {
    const url = new URL(value.trim());
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || value.length > 8192) throw new Error("Invalid invitation URL");
    importNetworkInvite(url.hash, true);
    networkProbe = { state: "unverified" };
    updateNetworkConfigUI();
  },
};
networkSaveBtn?.addEventListener("click", () => { try { saveNetworkConfigFromUI(); } catch (e) { networkActivityEl.textContent = e.message; } });
byId("networkDisconnectBtn")?.addEventListener("click", () => {
  window.ppssppAdhocTransport?.disconnect();
  networkProbe = { state: "unverified" };
  renderNetworkStatus();
});
byId("networkReconnectBtn")?.addEventListener("click", () => {
  const reconnect = window.Module?._ppssppAdhocReconnect;
  const result = reconnect ? reconnect() : -1;
  if (result === 0) { networkLiveStatus = { state: "connecting", peers: [] }; renderNetworkStatus(); }
  if (networkActivityEl) networkActivityEl.textContent = result === 0
    ? "Core reconnect requested. Rejoin a session using the game's multiplayer menu."
    : "Enter the game's multiplayer menu first. Reconnect requires the updated WASM core.";
});
networkEnableToggle?.addEventListener("change", () => { try { saveNetworkConfigFromUI(); checkNetworkWhenVisible(); } catch (e) { networkActivityEl.textContent = e.message; } });
networkTestBtn?.addEventListener("click", testNetworkRelay);
for (const id of ["networkServerInput", "networkRoomInput", "networkSessionKeyInput", "networkNickInput", "networkMacInput"]) {
  byId(id)?.addEventListener("input", () => {
    networkDraftDirty = true;
    networkProbe = { state: "unverified" };
    renderNetworkStatus();
    if (networkActivityEl) networkActivityEl.textContent = "Unsaved changes. Save settings to apply them; restart the emulator if already running.";
  });
}
window.addEventListener("offline", renderNetworkStatus);
window.addEventListener("online", () => { networkProbe = { state: "unverified" }; renderNetworkStatus(); checkNetworkWhenVisible(); });
if (!LOCAL_ONLY) setInterval(checkNetworkWhenVisible, 30000);

/* ── State ──────────────────────────────────────────────────────── */
let selectedGame = null;
let selectedStoredGame = null;
let selectedGameCached = false;
let started      = false;
let runtimeReady = false;
let runtimeFailed = false;
const trackedAudioContexts = [];
const audioDebug = {
  callbacks: 0, nonsilent: 0, peak: 0, rate: 0, deviceStarted: false,
  pushes: 0, pushNonsilent: 0, pushPeak: 0,
  workletPeak: 0, workletTotal: 0, ringDropped: 0, underruns: 0, fallbackPeak: 0, fallbackDropped: 0,
};

function updateIdleOverlay() {
  if (!idleOverlay || started) return;
  let text = "选择本机的游戏文件开始游玩，也可以从游戏库启动已导入的游戏。";
  if (selectedGame) text = "准备启动 " + selectedGame.name + ".";
  else if (selectedStoredGame) text = "准备启动 " + selectedStoredGame + "（来自游戏库）。";
  if (idleSubtitle) idleSubtitle.textContent = text;
}
updateIdleOverlay();

function setStartButtonMode(mode) {
  if (!startBtn) return;
  if (mode === "running") {
    startBtn.disabled = true;
    startBtn.style.display = "none";
    startBtn.title = "模拟器正在运行";
    startBtn.innerHTML = `${svgIcon("play")}<span class="btn-lbl"> 运行中</span>`;
  } else if (mode === "loading") {
    startBtn.disabled = true;
    startBtn.style.display = "";
    startBtn.title = "正在启动模拟器";
    startBtn.innerHTML = `${svgIcon("play")}<span class="btn-lbl"> 启动游戏</span>`;
  } else {
    startBtn.disabled = false;
    startBtn.style.display = "";
    startBtn.title = "启动模拟器";
    startBtn.innerHTML = `${svgIcon("play")}<span class="btn-lbl"> 启动游戏</span>`;
  }
}

/* ── Toast ──────────────────────────────────────────────────────── */
const toastEl = byId("toast");
function showToast(msg, ms = 3200) {
  if (!toastEl) {
    console.log("Toast:", msg);
    return;
  }
  toastEl.textContent = msg;
  toastEl.classList.add("visible");
  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(() => toastEl.classList.remove("visible"), ms);
}

/* ── OPFS Persistence ───────────────────────────────────────────── */
let _opfsRoot = null;
let _detectedMemstick = null;
let _lastPersistTime  = 0;
// path → "size:mtime" fingerprint of the last successfully persisted state
let _persistedFileState = new Map();

function hasOPFS() {
  return !!navigator.storage?.getDirectory;
}

async function opfsRoot() {
  if (!hasOPFS()) throw new Error("此浏览器未开放本地文件存储，请检查网站存储权限");
  if (_opfsRoot) return _opfsRoot;
  const origin = await navigator.storage.getDirectory();
  _opfsRoot = await origin.getDirectoryHandle(OPFS_ROOT_DIR, { create: true });
  return _opfsRoot;
}

async function opfsDir(parts, create) {
  let dir = await opfsRoot();
  for (const part of parts) dir = await dir.getDirectoryHandle(part, { create });
  return dir;
}

function opfsPathParts(path) {
  return path.split("/").filter(Boolean);
}

async function opfsParent(path, create, base = OPFS_PERSIST_DIR) {
  const parts = opfsPathParts(path);
  const name = parts.pop();
  if (!name) throw new Error("Invalid OPFS path: " + path);
  return { dir: await opfsDir([base, ...parts], create), name };
}

async function writeOpfsHandle(handle, data) {
  const writable = await handle.createWritable();
  try {
    await writable.write(data);
    await writable.close();
  } catch (error) {
    try { await writable.abort(); } catch (_) {}
    throw error;
  }
}

async function opfsPut(path, data) {
  const { dir, name } = await opfsParent(path, true);
  const handle = await dir.getFileHandle(name, { create: true });
  await writeOpfsHandle(handle, data);
}

async function opfsRead(path, handle) {
  if (!handle) {
    const { dir, name } = await opfsParent(path, false);
    handle = await dir.getFileHandle(name);
  }
  return new Uint8Array(await (await handle.getFile()).arrayBuffer());
}

async function opfsDelete(path) {
  const { dir, name } = await opfsParent(path, false);
  await dir.removeEntry(name);
}

async function opfsClearAll() {
  return globalThis.PpssppGameStorage.withExclusive(async () => {
    await playerSettingsQueue;
    const root = await opfsRoot();
    for (const name of [OPFS_PERSIST_DIR, OPFS_GAMES_DIR, OPFS_GAME_META_DIR, "game-downloads", "legacy-backups", "player"]) {
      try { await root.removeEntry(name, { recursive: true }); }
      catch (error) { if (error.name !== "NotFoundError") throw error; }
    }
    preferences.removeItem(PLAYER_SETTINGS_KEY);
    playerSettingsChanged = true;
    refreshPlayerSettingsUI();
    preferences.removeItem(PRELOAD_FAVORITES_KEY);
    preferences.removeItem(PRELOAD_FAVORITES_MIGRATED_KEY);
    await root.getDirectoryHandle(OPFS_PERSIST_DIR, { create: true });
    await root.getDirectoryHandle(OPFS_GAMES_DIR, { create: true });
    await root.getDirectoryHandle(OPFS_GAME_META_DIR, { create: true });
  });
}

async function opfsWalk(base = OPFS_PERSIST_DIR, prefix = "", includeData = true) {
  const files = [];
  let dir;
  try { dir = await opfsDir([base, ...opfsPathParts(prefix)], false); }
  catch(e) { if (e.name === "NotFoundError") return files; throw e; }

  for await (const [name, handle] of dir.entries()) {
    const rel = prefix ? prefix + "/" + name : name;
    if (handle.kind === "directory") {
      files.push(...await opfsWalk(base, rel, includeData));
    } else {
      const file = await handle.getFile();
      const entry = {
        path: base === OPFS_PERSIST_DIR ? "/" + rel : rel,
        name,
        size: file.size,
      };
      if (includeData) entry.data = new Uint8Array(await file.arrayBuffer());
      files.push(entry);
    }
  }
  return files;
}

async function opfsRestoreEntries() {
  let dir;
  try { dir = await opfsDir([OPFS_PERSIST_DIR], false); }
  catch (error) { if (error.name === "NotFoundError") return []; throw error; }
  const files = [];
  // Restoration needs paths and fresh reads, not size snapshots. Keep handles
  // only for this attempt, using enumerated directories instead of reopening them.
  async function walk(directory, prefix) {
    for await (const [name, handle] of directory.entries()) {
      const relative = prefix ? prefix + "/" + name : name;
      if (handle.kind === "directory") await walk(handle, relative);
      else files.push({ path: "/" + relative, handle });
    }
  }
  await walk(dir, "");
  return files;
}

async function opfsPutGame(name, data) {
  return globalThis.PpssppGameStorage.withExclusive(async () => {
    const safe = name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const { dir, name: fileName } = await opfsParent(safe, true, OPFS_GAMES_DIR);
    const handle = await dir.getFileHandle(fileName, { create: true });
    await writeOpfsHandle(handle, data);
    try { await writeGameMetadata(safe, data); }
    catch(e) { log("Library metadata failed for " + safe + ": " + e.message, "warn"); }
    return safe;
  });
}

async function opfsReadGame(name) {
  const { dir, name: fileName } = await opfsParent(name, false, OPFS_GAMES_DIR);
  const handle = await dir.getFileHandle(fileName);
  return new Uint8Array(await (await handle.getFile()).arrayBuffer());
}

async function opfsGetGameFile(name) {
  const { dir, name: fileName } = await opfsParent(name, false, OPFS_GAMES_DIR);
  const handle = await dir.getFileHandle(fileName);
  return await handle.getFile();
}

async function opfsDeleteGame(name) {
  const { dir, name: fileName } = await opfsParent(name, false, OPFS_GAMES_DIR);
  await dir.removeEntry(fileName);
  await deleteGameMetadata(name);
}

// Walk Emscripten FS recursively from root, return [{path, data}]
function fsWalkDir(FS, root) {
  const files = [];
  function walk(dir) {
    let entries; try { entries = FS.readdir(dir); } catch(e) { return; }
    for (const name of entries) {
      if (name === "." || name === "..") continue;
      const full = dir + "/" + name;
      let stat; try { stat = FS.stat(full); } catch(e) { continue; }
      if      (FS.isDir(stat.mode))  walk(full);
      else if (FS.isFile(stat.mode)) {
        try { files.push({ path: full, data: FS.readFile(full) }); } catch(e) {}
      }
    }
  }
  walk(root);
  return files;
}

// Walk FS collecting stat info only — no data read, very cheap
function fsStatDir(FS, root) {
  const stats = new Map(); // path → {size, mtime}
  function walk(dir) {
    let entries; try { entries = FS.readdir(dir); } catch(e) { return; }
    for (const name of entries) {
      if (name === "." || name === "..") continue;
      const full = dir + "/" + name;
      let st; try { st = FS.stat(full); } catch(e) { continue; }
      if      (FS.isDir(st.mode))  walk(full);
      else if (FS.isFile(st.mode)) stats.set(full, { size: st.size, mtime: st.mtime });
    }
  }
  walk(root);
  return stats;
}

function fsMkdirP(FS, fullPath) {
  const parts = fullPath.split("/").filter(Boolean);
  let cur = "";
  for (const p of parts) {
    cur += "/" + p;
    try { FS.mkdir(cur); } catch(e) {}
  }
}

function detectMemstickDir(FS) {
  return PERSIST_ROOTS[0];
}

function normalizePersistPath(path) {
  if (typeof path !== "string" || path.includes("\\")) throw new Error("存档路径无效");
  const parts = path.split("/").filter(Boolean);
  if (parts.some(part => part === "." || part === "..")) throw new Error("存档路径无效");
  const absolute = "/" + parts.join("/");
  const root = PERSIST_ROOTS.find(candidate => absolute.startsWith(candidate + "/"));
  if (!root) throw new Error("存档路径不属于此模拟器，请使用存档文件夹导入。");
  return { sourcePath: absolute, path: PERSIST_ROOTS[0] + absolute.slice(root.length), legacy: root !== PERSIST_ROOTS[0] };
}

function persistConflictKey(path) {
  // A savedata slot is a set of mutually-dependent files. Never mix files from
  // an old-root slot with an already-existing current-root slot.
  const slot = path.match(/^(.*\/PSP\/SAVEDATA\/[^/]+)\//i);
  return slot ? slot[1] + "/" : path;
}

function selectPersistEntries(entries, existingPaths = []) {
  const normalized = entries.map(entry => ({ ...entry, ...normalizePersistPath(entry.path) }));
  const protectedKeys = new Set();
  for (const path of existingPaths) {
    const entry = normalizePersistPath(path);
    if (!entry.legacy) protectedKeys.add(persistConflictKey(entry.path));
  }
  for (const entry of normalized) {
    if (!entry.legacy) protectedKeys.add(persistConflictKey(entry.path));
  }
  const selected = normalized.filter(entry => !entry.legacy || !protectedKeys.has(persistConflictKey(entry.path)));
  const skippedEntries = normalized.filter(entry => entry.legacy && protectedKeys.has(persistConflictKey(entry.path)));
  return { entries: selected, skipped: skippedEntries.length, skippedEntries };
}

async function archiveLegacyPersistFile(path, data) {
  const { dir, name } = await opfsParent(path, true, "legacy-backups");
  await writeOpfsHandle(await dir.getFileHandle(name, { create: true }), data);
  // Only remove the active legacy copy after the backup transaction commits.
  // Otherwise a deleted migrated slot would reappear at the next startup.
  await opfsDelete(path);
}

async function rollbackSaveMigration(FS) {
  let dir, file;
  try {
    dir = await opfsDir(["player"], false);
    file = await (await dir.getFileHandle("save-migration.json")).getFile();
  } catch (error) { if (error.name === "NotFoundError") return; throw error; }
  const text = await file.text();
  // A failed first createWritable can leave an empty journal, before any target
  // has been touched. A nonempty invalid journal must stop startup for recovery.
  if (text) {
    const pending = JSON.parse(text);
    if (pending.version !== 1 || !Array.isArray(pending.targets)) throw new Error("存档迁移记录无效");
    const targets = pending.targets.map(path => {
      const entry = normalizePersistPath(path);
      if (entry.legacy || entry.path !== path) throw new Error("存档迁移记录路径无效");
      return path;
    });
    for (const path of targets) {
      try { await opfsDelete(path); } catch (error) { if (error.name !== "NotFoundError") throw error; }
      try { FS.unlink(path); } catch (_) {}
    }
  }
  await dir.removeEntry("save-migration.json");
}

async function beginSaveMigration(targets) {
  const dir = await opfsDir(["player"], true);
  await writeOpfsHandle(await dir.getFileHandle("save-migration.json", { create: true }),
    JSON.stringify({ version: 1, targets }));
  return dir;
}

function formatBytes(n) {
  if (n < 1024)    return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
  return (n / 1048576).toFixed(1) + " MB";
}

function bytesToBase64(data) {
  const bytes = new Uint8Array(data);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function base64ToBytes(data) {
  return Uint8Array.from(atob(data), c => c.charCodeAt(0));
}

function stripGameExtension(name) {
  return name.replace(GAME_FILE_EXT_RE, "");
}

function prettyGameName(name) {
  return stripGameExtension(name).replace(/[._-]+/g, " ").replace(/\s+/g, " ").trim() || name;
}

function dataToObjectURL(data, type = "application/octet-stream") {
  return URL.createObjectURL(new Blob([data], { type }));
}

function readIsoDirRecord(view, offset) {
  const len = view.getUint8(offset);
  if (!len) return null;
  const extent = view.getUint32(offset + 2, true);
  const size = view.getUint32(offset + 10, true);
  const flags = view.getUint8(offset + 25);
  const nameLen = view.getUint8(offset + 32);
  let name = "";
  for (let i = 0; i < nameLen; i++) name += String.fromCharCode(view.getUint8(offset + 33 + i));
  name = name.replace(/;1$/i, "");
  return { len, extent, size, flags, name };
}

function isoFindEntry(bytes, wantedPath) {
  if (!bytes || bytes.byteLength < 17 * 2048) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pvd = 16 * 2048;
  if (view.getUint8(pvd) !== 1) return null;
  let ident = "";
  for (let i = 1; i < 6; i++) ident += String.fromCharCode(view.getUint8(pvd + i));
  if (ident !== "CD001") return null;
  const root = readIsoDirRecord(view, pvd + 156);
  if (!root) return null;

  const parts = wantedPath.toUpperCase().split("/").filter(Boolean);
  let dir = root;
  for (let depth = 0; depth < parts.length; depth++) {
    const target = parts[depth];
    const start = dir.extent * 2048;
    const end = Math.min(start + dir.size, bytes.byteLength);
    let found = null;

    for (let off = start; off < end;) {
      const len = view.getUint8(off);
      if (!len) {
        off = (Math.floor(off / 2048) + 1) * 2048;
        continue;
      }
      const rec = readIsoDirRecord(view, off);
      off += len;
      if (!rec || rec.name === "\x00" || rec.name === "\x01") continue;
      if (rec.name.toUpperCase() === target) {
        found = rec;
        break;
      }
    }

    if (!found) return null;
    if (depth < parts.length - 1 && !(found.flags & 2)) return null;
    dir = found;
  }

  const dataStart = dir.extent * 2048;
  if (dataStart + dir.size > bytes.byteLength) return null;
  return bytes.slice(dataStart, dataStart + dir.size);
}

function parsePsfTitle(data) {
  if (!data || data.byteLength < 20) return "";
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.getUint32(0, true) !== 0x46535000) return "";
  const keyTable = view.getUint32(8, true);
  const dataTable = view.getUint32(12, true);
  const count = view.getUint32(16, true);
  const decoder = new TextDecoder();

  for (let i = 0; i < count; i++) {
    const off = 20 + i * 16;
    const keyOff = view.getUint16(off, true);
    const dataLen = view.getUint32(off + 4, true);
    const dataOff = view.getUint32(off + 12, true);
    let keyEnd = keyTable + keyOff;
    while (keyEnd < data.byteLength && data[keyEnd] !== 0) keyEnd++;
    const key = decoder.decode(data.slice(keyTable + keyOff, keyEnd));
    if (key !== "TITLE") continue;
    const raw = data.slice(dataTable + dataOff, dataTable + dataOff + dataLen);
    return decoder.decode(raw).replace(/\0+$/g, "").trim();
  }
  return "";
}

function extractIsoMetadata(name, data) {
  const meta = {
    fileName: name,
    title: prettyGameName(name),
    format: (name.split(".").pop() || "").toUpperCase(),
    coverBytes: null,
    coverType: "",
  };
  if (!/\.iso$/i.test(name)) return meta;

  try {
    const sfo = isoFindEntry(data, "PSP_GAME/PARAM.SFO");
    const title = parsePsfTitle(sfo);
    if (title) meta.title = title;
  } catch(e) {}

  try {
    const icon = isoFindEntry(data, "PSP_GAME/ICON0.PNG");
    if (icon?.byteLength) {
      meta.coverBytes = icon;
      meta.coverType = "image/png";
    }
  } catch(e) {}
  return meta;
}

async function opfsMetaPut(path, data) {
  const { dir, name } = await opfsParent(path, true, OPFS_GAME_META_DIR);
  const handle = await dir.getFileHandle(name, { create: true });
  await writeOpfsHandle(handle, data);
}

async function opfsMetaRead(path) {
  const { dir, name } = await opfsParent(path, false, OPFS_GAME_META_DIR);
  const handle = await dir.getFileHandle(name);
  return new Uint8Array(await (await handle.getFile()).arrayBuffer());
}

async function isoFindBlobEntry(blob, wantedPath) {
  const read = async (offset, size) => {
    if (size > 8 * 1024 * 1024 || offset < 0 || offset + size > blob.size) throw new Error("Invalid ISO extent");
    return new Uint8Array(await blob.slice(offset, offset + size).arrayBuffer());
  };
  const pvd = await read(16 * 2048, 2048);
  if (pvd[0] !== 1 || new TextDecoder().decode(pvd.subarray(1, 6)) !== "CD001") return null;
  let entry = readIsoDirRecord(new DataView(pvd.buffer), 156);
  const parts = wantedPath.toUpperCase().split("/").filter(Boolean);
  for (let depth = 0; depth < parts.length; depth++) {
    if (!entry || !(entry.flags & 2)) return null;
    const bytes = await read(entry.extent * 2048, entry.size);
    const view = new DataView(bytes.buffer);
    let found = null;
    for (let off = 0; off < bytes.length;) {
      const len = bytes[off];
      if (!len) { off = (Math.floor(off / 2048) + 1) * 2048; continue; }
      if (len < 34 || off + len > bytes.length || bytes[off + 32] > len - 33) return null;
      const rec = readIsoDirRecord(view, off);
      if (rec.name.toUpperCase() === parts[depth]) { found = rec; break; }
      off += len;
    }
    if (!found) return null;
    entry = found;
  }
  return entry ? read(entry.extent * 2048, entry.size) : null;
}

async function extractGameMetadata(name, data) {
  if (!(data instanceof Blob)) return extractIsoMetadata(name, data);
  const meta = extractIsoMetadata(name, null);
  if (!/\.iso$/i.test(name)) return meta;
  try {
    const title = parsePsfTitle(await isoFindBlobEntry(data, "PSP_GAME/PARAM.SFO"));
    if (title) meta.title = title;
    const cover = await isoFindBlobEntry(data, "PSP_GAME/ICON0.PNG");
    if (cover?.length) { meta.coverBytes = cover; meta.coverType = "image/png"; }
  } catch (_) { /* Invalid/unsupported metadata must not prevent playing. */ }
  return meta;
}

async function writeGameMetadata(name, data) {
  const meta = await extractGameMetadata(name, data);
  const json = {
    fileName: meta.fileName,
    title: meta.title,
    format: meta.format,
    coverType: meta.coverType,
    updated: Date.now(),
  };
  await opfsMetaPut(name + ".json", new TextEncoder().encode(JSON.stringify(json)));
  if (meta.coverBytes) await opfsMetaPut(name + ".cover", meta.coverBytes);
}

async function readGameMetadata(name) {
  try {
    const data = await opfsMetaRead(name + ".json");
    return JSON.parse(new TextDecoder().decode(data));
  } catch(e) {
    return { fileName: name, title: prettyGameName(name), format: (name.split(".").pop() || "").toUpperCase(), coverType: "" };
  }
}

async function readGameCoverURL(name, type) {
  if (!type) return "";
  try { return dataToObjectURL(await opfsMetaRead(name + ".cover"), type); }
  catch(e) { return ""; }
}

async function deleteGameMetadata(name) {
  const root = await opfsRoot();
  let dir;
  try { dir = await root.getDirectoryHandle(OPFS_GAME_META_DIR); } catch(e) { return; }
  try { await dir.removeEntry(name + ".json"); } catch(e) {}
  try { await dir.removeEntry(name + ".cover"); } catch(e) {}
}

// Categorize an OPFS path for the file browser
function opfsFileCategory(path) {
  if (/\/PSP\/SAVEDATA\//i.test(path))     return "游戏存档";
  if (/\/PSP\/PPSSPP_STATE\//i.test(path)) return "即时存档";
  if (/\/PSP\/SYSTEM\//i.test(path))       return "系统设置";
  if (/\/PSP\/GAME\//i.test(path))         return "PSP 游戏";
  if (/\/PSP\/SCREENSHOT\//i.test(path))   return "截图";
  if (/\/PSP\/CHEATS\//i.test(path))       return "金手指";
  if (/\.ini$|config\.json$/i.test(path))  return "配置文件";
  return "其他";
}

async function downloadOpfsFile(path) {
  try {
    const data = await opfsRead(path);
    const name = path.split("/").pop();
    const blob = new Blob([data], { type: "application/octet-stream" });
    const url  = URL.createObjectURL(blob);
    Object.assign(document.createElement("a"), { href: url, download: name }).click();
    URL.revokeObjectURL(url);
    showToast("✓ 已导出 " + name);
  } catch(e) { showToast("操作未完成：" + e.message); }
}

async function deleteOpfsFile(path) {
  if (!confirm("从本机存储中删除：\n" + path.split("/").pop() + "?")) return;
  try { await opfsDelete(path); } catch(e) {}
  if (window.FS) { try { window.FS.unlink(path); } catch(e) {} }
  showToast("已删除 " + path.split("/").pop());
  updateStorageInfo(); refreshSavesTab();
}

async function updateStorageInfo() {
  try {
    const entries = await opfsWalk(OPFS_PERSIST_DIR, "", false);
    const games   = await opfsWalk(OPFS_GAMES_DIR, "", false);
    const allFiles = [...entries, ...games.map(g => ({ ...g, path: VIRTUAL_GAME_DIR + "/" + g.path }))];
    const bytes   = allFiles.reduce((s, e) => s + (e.data?.byteLength || e.size || 0), 0);
    const el = id => document.getElementById(id);
    el("iStorageFiles").textContent = String(allFiles.length);
    el("iStorageFiles").className   = allFiles.length ? "info-val good" : "info-val";
    el("iStorageSize").textContent  = formatBytes(bytes);
    el("iLastSync").textContent     = _lastPersistTime
      ? new Date(_lastPersistTime).toLocaleTimeString() : "尚未同步";
    el("iMemstickPath").textContent = _detectedMemstick || PERSIST_ROOTS[0];

    // Render grouped file browser
    const listEl = document.getElementById("opfsFileList");
    if (listEl) {
      if (!allFiles.length) {
        listEl.innerHTML = `<span class="empty-row">尚无本机存储文件。</span>`;
      } else {
        // Group by category
        const cats = new Map();
        for (const { path, data, size } of allFiles) {
          const cat = path.startsWith(VIRTUAL_GAME_DIR + "/") ? "游戏库" : opfsFileCategory(path);
          if (!cats.has(cat)) cats.set(cat, []);
          cats.get(cat).push({ path, size: data?.byteLength || size || 0 });
        }
        // Sort categories: Config first, then alphabetical
        const catOrder = ["游戏库", "配置文件", "系统设置", "即时存档", "游戏存档", "截图", "金手指", "PSP 游戏", "其他"];
        const sorted = [...cats.entries()].sort((a, b) => {
          const ai = catOrder.indexOf(a[0]); const bi = catOrder.indexOf(b[0]);
          return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
        });
        let html = "";
        for (const [cat, files] of sorted) {
          const catBytes = files.reduce((s, f) => s + f.size, 0);
          html += `<div class="opfs-cat-header"><span>${esc(cat)} (${files.length})</span><span class="opfs-cat-size">${formatBytes(catBytes)}</span></div>`;
          for (const { path, size } of files.sort((a, b) => a.path.localeCompare(b.path))) {
            const name = path.split("/").pop();
            html += `<div class="opfs-file-row">`;
            html += `<div class="opfs-file-name" title="${esc(path)}">${esc(name)}</div>`;
            html += `<div class="opfs-file-size">${formatBytes(size)}</div>`;
            html += `<div class="opfs-file-actions">`;
            html += `<button title="导出" onclick="downloadStoredFile(${JSON.stringify(path)})">${svgIcon("download")}</button>`;
            html += `<button class="del" title="删除" onclick="deleteStoredFile(${JSON.stringify(path)})">${svgIcon("trash")}</button>`;
            html += `</div>`;
            html += `</div>`;
          }
        }
        listEl.innerHTML = html;
      }
    }
  } catch(e) { log("OPFS storage info error: " + e.message, "warn"); }
}

async function downloadStoredFile(path) {
  if (path.startsWith(VIRTUAL_GAME_DIR + "/")) {
    const name = path.slice((VIRTUAL_GAME_DIR + "/").length);
    const file = await opfsGetGameFile(name);
    const url = URL.createObjectURL(file);
    Object.assign(document.createElement("a"), { href: url, download: name }).click();
    URL.revokeObjectURL(url);
    showToast("✓ 已导出 " + name);
  } else {
    await downloadOpfsFile(path);
  }
}

async function deleteStoredFile(path) {
  if (path.startsWith(VIRTUAL_GAME_DIR + "/")) {
    const name = path.slice((VIRTUAL_GAME_DIR + "/").length);
    if (globalThis.PpssppBrowserFiles?.has(path)) { showToast("游戏已载入，请先同步存档并重新载入页面后再删除。"); return; }
    if (!confirm("从本机游戏库中删除：\n" + name + "?")) return;
    try {
      await globalThis.PpssppGameStorage.withExclusive(async () => {
        await opfsDeleteGame(name);
        if (window.FS) { try { window.FS.unlink(path); } catch(e) {} }
      });
      setPreloadFavorite(name, false);
      refreshEmulatorGameBrowser("deleted " + name);
      showToast("已删除 " + name);
      await refreshLibrary();
      updateStorageInfo();
    } catch(e) {
      log("Delete game file failed: " + e.message, "err");
      showToast("删除失败：" + e.message);
    }
  } else {
    await deleteOpfsFile(path);
  }
}

async function togglePreloadFavorite(name) {
  const enable = !isPreloadFavorite(name);
  setPreloadFavorite(name, enable);
  if (!enable) {
    showToast("已取消启动时载入：" + name);
    await refreshLibrary();
    return;
  }

  showToast("已设置启动时载入：" + name);
  if (started && window.FS && !window.FS.analyzePath?.(VIRTUAL_GAME_DIR + "/" + name)?.exists) {
    await playOrMountStoredGame(name);
  } else {
    await refreshLibrary();
  }
}

async function playOrMountStoredGame(name) {
  if (!validateGameSelection(name)) return;
  if (!started || !window.FS) {
    selectedStoredGame = name;
    selectedGame = null;
    selectedGameCached = true;
    if (fileLabel) fileLabel.title = name;
    updateIdleOverlay();
    const textNode = fileLabel?.firstChild;
    if (textNode && textNode.nodeType === 3) textNode.textContent = "\uD83D\uDCC2 " + name + " ";
    setStatus("正在启动 " + name, "run");
    showToast("正在启动 " + name + "…");
    start();
    return;
  }

  const FS = window.FS;
  const path = VIRTUAL_GAME_DIR + "/" + name;
  try {
    showToast("正在载入 " + name + "…");
    FS.mkdirTree(VIRTUAL_GAME_DIR);
    mountBrowserGame(FS, await opfsGetGameFile(name), name);
    log("Mounted stored game file from OPFS: " + path, "ok");
    refreshEmulatorGameBrowser("mounted " + name);
    showToast("✓ " + name + " 已载入");
    refreshLibrary();
  } catch(e) {
    log("Stored game mount failed: " + e.message, "err");
    showToast("操作未完成：" + e.message);
  }
}

async function showGameInfo(name) {
  try {
    const meta = await ensureGameMetadata(name);
    const stat = (await opfsWalk(OPFS_GAMES_DIR, "", false)).find(g => g.path === name);
    const mounted = !!window.FS?.analyzePath?.(VIRTUAL_GAME_DIR + "/" + name).exists;
    const preloads = isPreloadFavorite(name);
    const title = meta.title || prettyGameName(name);
    const cover = await readGameCoverURL(name, meta.coverType);
    if (cover) _libraryCoverURLs.push(cover);

    const titleEl = byId("gameInfoTitle");
    const coverEl = byId("gameInfoCover");
    const rowsEl = byId("gameInfoRows");
    const modalEl = byId("gameInfoModal");
    if (!titleEl || !coverEl || !rowsEl || !modalEl) {
      showToast("游戏详情面板暂不可用，请重新载入页面。");
      return;
    }

    titleEl.textContent = title;
    coverEl.innerHTML = cover
      ? `<img src="${cover}" alt="${esc(title)} 封面">`
      : `<div class="game-cover" style="height:100%;background:${gameAccent(name)}"><div class="game-cover-fallback">${esc(title.split(/\s+/).slice(0, 4).join(" "))}</div></div>`;
    rowsEl.innerHTML = [
      ["文件", name],
      ["格式", meta.format || "未知"],
      ["大小", formatBytes(stat?.size || 0)],
      ["本机位置", "OPFS /" + OPFS_GAMES_DIR + "/" + name],
      ["运行位置", VIRTUAL_GAME_DIR + "/" + name],
      ["已载入", mounted ? "是" : "否"],
      ["启动时载入", preloads ? "是" : "否"],
      ["封面", meta.coverType ? "有" : "无"],
    ].map(([k, v]) => `<div class="game-info-row"><span>${esc(k)}</span><span>${esc(v)}</span></div>`).join("");

    const favoriteBtn = byId("gameInfoFavoriteBtn");
    if (favoriteBtn) {
      favoriteBtn.innerHTML = `${svgIcon("preload")} ${preloads ? "已设为启动时载入" : "启动时载入"}`;
      favoriteBtn.classList.toggle("active", preloads);
      favoriteBtn.setAttribute("aria-pressed", preloads ? "true" : "false");
      favoriteBtn.onclick = async () => {
        closeGameInfo();
        await togglePreloadFavorite(name);
      };
    }

    const playBtn = byId("gameInfoPlayBtn");
    if (playBtn) {
      playBtn.textContent = started ? (mounted ? "已载入" : "载入") : "开始游戏";
      playBtn.disabled = started && mounted;
      playBtn.onclick = () => {
        closeGameInfo();
        playOrMountStoredGame(name);
      };
    }
    modalEl.classList.add("visible");
    modalEl.setAttribute("aria-hidden", "false");
  } catch(e) {
    log("Game info failed: " + e.message, "err");
    showToast("读取游戏详情失败：" + e.message);
  }
}

function closeGameInfo() {
  const modal = byId("gameInfoModal");
  if (!modal) return;
  modal.classList.remove("visible");
  modal.setAttribute("aria-hidden", "true");
}

function refreshEmulatorGameBrowser(reason) {
  const refresh = window.Module?._PPSSPP_RefreshGameBrowser;
  if (typeof refresh !== "function") {
    log("PPSSPP UI refresh hook is not available in this WASM build.", "dim");
    return false;
  }
  try {
    refresh();
    log("PPSSPP UI refresh requested" + (reason ? ": " + reason : "") + ".", "ok");
    return true;
  } catch(e) {
    log("PPSSPP UI refresh failed: " + (e?.message || e), "warn");
    return false;
  }
}

const mountOrSelectStoredGame = playOrMountStoredGame;
window.playOrMountStoredGame = playOrMountStoredGame;
window.mountOrSelectStoredGame = playOrMountStoredGame;
window.showGameInfo = showGameInfo;
window.closeGameInfo = closeGameInfo;
window.downloadStoredFile = downloadStoredFile;
window.deleteStoredFile = deleteStoredFile;

let _libraryCoverURLs = [];

function clearLibraryCoverURLs() {
  for (const url of _libraryCoverURLs) URL.revokeObjectURL(url);
  _libraryCoverURLs = [];
}

function loadPreloadFavorites() {
  try {
    const parsed = JSON.parse(preferences.getItem(PRELOAD_FAVORITES_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter(name => typeof name === "string" && name) : [];
  } catch(e) {
    return [];
  }
}

function savePreloadFavorites(names) {
  const unique = [...new Set(names.filter(name => typeof name === "string" && name))].sort((a, b) => a.localeCompare(b));
  preferences.setItem(PRELOAD_FAVORITES_KEY, JSON.stringify(unique));
  updatePreloadFavoriteSummary(unique.length);
  return unique;
}

function isPreloadFavorite(name) {
  return loadPreloadFavorites().includes(name);
}

function setPreloadFavorite(name, enabled) {
  const favorites = loadPreloadFavorites();
  const next = enabled ? [...favorites, name] : favorites.filter(item => item !== name);
  return savePreloadFavorites(next);
}

function ensurePreloadFavoritesMigrated() {
  preferences.setItem(PRELOAD_FAVORITES_MIGRATED_KEY, "1");
  preferences.setItem(PRELOAD_DEFAULTS_APPLIED_KEY, "1");
  return loadPreloadFavorites();
}

function prunePreloadFavorites(existingNames) {
  const existing = new Set(existingNames);
  const favorites = ensurePreloadFavoritesMigrated(existingNames);
  const next = favorites.filter(name => existing.has(name));
  if (next.length !== favorites.length) savePreloadFavorites(next);
  else updatePreloadFavoriteSummary(next.length);
  return next;
}

function updatePreloadFavoriteSummary(count = loadPreloadFavorites().length) {
  const el = byId("libraryPreloadCount");
  if (el) el.textContent = count + " 项启动时载入";
}

async function ensureGameMetadata(name) {
  const meta = await readGameMetadata(name);
  if (meta.updated) return meta;
  try {
    const file = await opfsGetGameFile(name);
    await writeGameMetadata(name, file);
    return await readGameMetadata(name);
  } catch(e) {
    return meta;
  }
}

function gameAccent(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;

  const hue2 = (hue + 42) % 360;
  return '#0a4a8a';
}

async function refreshLibrary() {
  const grid = document.getElementById("libraryGrid");
  const empty = document.getElementById("libraryEmpty");
  const count = document.getElementById("libraryCount");
  if (!grid || !empty) return;

  clearLibraryCoverURLs();
  grid.style.display = "none";
  empty.style.display = "block";
  empty.textContent = "正在读取游戏库…";

  try {
    const games = await opfsWalk(OPFS_GAMES_DIR, "", false);
    games.sort((a, b) => a.path.localeCompare(b.path));
    const preloadFavorites = new Set(prunePreloadFavorites(games.map(game => game.path)));
    if (count) count.textContent = games.length + " 个游戏";

    if (!games.length) {
      empty.innerHTML = "游戏库还是空的。<br>请添加本机游戏文件，或选择文件并启动。";
      return;
    }

    const cards = [];
    for (const game of games) {
      const meta = await ensureGameMetadata(game.path);
      const coverURL = await readGameCoverURL(game.path, meta.coverType);
      if (coverURL) _libraryCoverURLs.push(coverURL);
      const title = meta.title || prettyGameName(game.path);
      const format = meta.format || (game.path.split(".").pop() || "").toUpperCase();
      const mounted = !!window.FS?.analyzePath?.(VIRTUAL_GAME_DIR + "/" + game.path).exists;
      const preloads = preloadFavorites.has(game.path);
      const primary = started ? (mounted ? "已载入" : "载入") : "开始游戏";
      const primaryDisabled = started && mounted ? " disabled" : "";
      const fallback = title.split(/\s+/).slice(0, 4).join(" ");
      cards.push(`
        <div class="game-card">
          <div class="game-cover" style="background:${gameAccent(game.path)}">
            ${coverURL
              ? `<img src="${coverURL}" alt="${esc(title)} 封面" loading="lazy">`
              : `<div class="game-cover-fallback">${esc(fallback)}</div>`}
          </div>
          <div class="game-card-body">
            <div class="game-card-title" title="${esc(title)}">${esc(title)}</div>
            <div class="game-card-meta" title="${esc(game.path)}">${esc(format)} · ${formatBytes(game.size || 0)}${preloads ? " · 启动时载入" : ""}</div>
            <div class="game-card-actions">
              <button data-action="play" data-game="${esc(game.path)}"${primaryDisabled}>${primary}</button>
              <button class="icon-only preload-toggle${preloads ? " active" : ""}" title="${preloads ? "取消启动时载入" : "启动时载入"}" aria-pressed="${preloads ? "true" : "false"}" data-action="favorite" data-game="${esc(game.path)}">${svgIcon("preload")}</button>
              <button class="icon-only" title="详情" data-action="info" data-game="${esc(game.path)}">${svgIcon("info")}</button>
              <button class="icon-only danger" title="删除" data-action="delete" data-game="${esc(game.path)}">${svgIcon("trash")}</button>
            </div>
          </div>
        </div>
      `);
    }

    empty.style.display = "none";
    grid.style.display = "grid";
    grid.innerHTML = cards.join("");
  } catch(e) {
    empty.textContent = "读取游戏库失败：" + e.message;
    if (count) count.textContent = "0 个游戏";
  }
}

async function addGameToLibrary(file) {
  if (!validateGameSelection(file)) return;
  showToast("正在添加 " + file.name + "…");
  try {
    const storedName = await opfsPutGame(file.name, file);
    log("Library: added " + storedName + " to OPFS.", "ok");
    showToast("✓ 已添加 " + storedName);
    await refreshLibrary();
    updateStorageInfo();
  } catch(e) {
    log("Library add failed: " + e.message, "err");
    showToast("操作未完成：" + e.message);
  }
}

function filenameFromContentDisposition(header) {
  if (!header) return "";
  const utf = header.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (utf) {
    try { return decodeURIComponent(utf[1].replace(/^"|"$/g, "")); } catch(e) {}
  }
  const simple = header.match(/filename\s*=\s*"?([^";]+)"?/i);
  return simple ? simple[1].trim() : "";
}

function filenameFromURL(url) {
  try {
    const u = new URL(url, location.href);
    const name = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() || "");
    return name || "download.iso";
  } catch(e) {
    return "download.iso";
  }
}

async function readResponseBytes(response, label) {
  const total = Number(response.headers.get("content-length") || 0);
  if (!response.body?.getReader) return new Uint8Array(await response.arrayBuffer());

  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    if (total) {
      const pct = received / total;
      showLoading("Downloading " + label + "… " + Math.round(pct * 100) + "%", pct);
      setStatus("Downloading " + label + " (" + formatBytes(received) + " / " + formatBytes(total) + ")", "run");
    } else {
      showLoading("Downloading " + label + "… " + formatBytes(received));
      setStatus("Downloading " + label + " (" + formatBytes(received) + ")", "run");
    }
  }

  const out = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function storeGameResponse(name, response) {
  if (!response.ok) throw new Error("Game download failed: HTTP " + response.status);
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const { dir, name: fileName } = await opfsParent(safe, true, OPFS_GAMES_DIR);
  const handle = await dir.getFileHandle(fileName, { create: true });
  if (response.body) {
    const writable = await handle.createWritable();
    let received = 0, lastProgress = 0;
    const total = Number(response.headers.get("content-length")) || 0;
    const progress = new TransformStream({ transform(chunk, controller) {
      received += chunk.byteLength;
      if (performance.now() - lastProgress >= 200) {
        showLoading("Downloading " + safe + "… " + formatBytes(received), total ? received / total : undefined);
        lastProgress = performance.now();
      }
      controller.enqueue(chunk);
    } });
    // pipeTo applies backpressure and aborts the file transaction on failure.
    await response.body.pipeThrough(progress).pipeTo(writable);
  } else {
    await writeOpfsHandle(handle, await response.blob());
  }
  const file = await handle.getFile();
  try { await writeGameMetadata(safe, file); }
  catch (e) { log("Library metadata failed for " + safe + ": " + e.message, "warn"); }
  return { name: safe, size: file.size };
}

async function addGameURLToLibrary(url) {
  if (LOCAL_ONLY) { showToast("此版本只读取本机游戏文件，请使用“添加游戏”。"); return; }
  const trimmed = url.trim();
  if (!trimmed) { showToast("Paste a game URL first"); return; }

  let parsed;
  try { parsed = new URL(trimmed, location.href); }
  catch(e) { showToast("❌ Invalid URL"); return; }
  if (!/^https?:$/i.test(parsed.protocol)) {
    showToast("❌ Only http/https links are supported");
    return;
  }

  const fallbackName = filenameFromURL(parsed.href);
  showToast("Downloading " + fallbackName + "…");
  showLoading("Downloading " + fallbackName + "…");
  setStatus("Downloading " + fallbackName, "run");

  try {
    const response = await fetch(parsed.href, { mode: "cors" });
    if (!response.ok) throw new Error("HTTP " + response.status + " " + response.statusText);
    const headerName = filenameFromContentDisposition(response.headers.get("content-disposition"));
    const name = (headerName || fallbackName).replace(/[^a-zA-Z0-9._-]/g, "_");
    const stored = await storeGameResponse(name, response);
    const storedName = stored.name;
    hideLoading();
    log("Library: downloaded " + storedName + " from " + parsed.href + " (" + formatBytes(stored.size) + ").", "ok");
    showToast("✓ 已导出 " + storedName);
    setStatus("游戏库已就绪", "ok");
    const input = document.getElementById("libraryUrlInput");
    if (input) input.value = "";
    await refreshLibrary();
    updateStorageInfo();
  } catch(e) {
    hideLoading();
    const corsHint = /Failed to fetch|NetworkError|Load failed/i.test(e.message)
      ? " The server may need CORS enabled for browser downloads."
      : "";
    log("Library URL download failed: " + e.message + corsHint, "err");
    setStatus("Download failed", "err");
    showToast("操作未完成：" + e.message, 5000);
  }
}

// Convert binary data to a data: URL for inline display
function toDataURL(data, ext) {
  try {
    const mime = /png/i.test(ext) ? "image/png" : "image/jpeg";
    const bytes = new Uint8Array(data);
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return "data:" + mime + ";base64," + btoa(bin);
  } catch(e) { return null; }
}

/* ── Saves Tab ──────────────────────────────────────────────────── */
// PSP save paths:
//   SAVEDATA    → <memstick>/PSP/SAVEDATA/<GAMEID_TITLE>/<files>   (subdir per game)
//   PPSSPP_STATE → <memstick>/PSP/PPSSPP_STATE/<GAMEID>_ver_slot.ext  (FLAT, no subdir)
const SAVE_SUBDIRS = [
  { dir: "PSP/SAVEDATA",     flat: false, label: "游戏存档"   },
  { dir: "PSP/PPSSPP_STATE", flat: true,  label: "即时存档" },
];

function readSaveSlotFiles(FS, slotDir) {
  // returns [{name, path, size}] for all files inside a slot directory
  const files = [];
  let entries;
  try { entries = FS.readdir(slotDir); } catch(e) { return files; }
  for (const name of entries) {
    if (name === "." || name === "..") continue;
    const full = slotDir + "/" + name;
    try {
      const st = FS.stat(full);
      if (FS.isFile(st.mode)) files.push({ name, path: full, size: st.size });
    } catch(e) {}
  }
  return files;
}

// Build a unified file map from OPFS + live FS (FS takes priority as it's fresher)
async function buildSaveFileMap() {
  const opfsEntries = await opfsWalk();
  const map = new Map(); // path → {path, data, size, fromOPFS}
  const FS = window.FS;
  const fsFiles = FS ? fsWalkDir(FS, detectMemstickDir(FS)) : [];
  const selected = selectPersistEntries(opfsEntries, fsFiles.map(file => file.path));
  for (const entry of selected.entries) {
    // Before the first launch, an unmigrated legacy file is still downloaded
    // from its original OPFS path. Once migrated its canonical copy wins.
    const path = entry.sourcePath;
    map.set(path, { ...entry, path, size: entry.data?.byteLength || entry.size || 0, fromOPFS: true });
  }
  // Overlay with live FS (newer / authoritative), using the same absolute keys.
  for (const { path, data } of fsFiles) {
    map.set(path, { path, data, size: data?.byteLength || 0, fromOPFS: false });
  }
  return map;
}

// Extract game ID from a flat save-state filename like "ULES01384_1.00_0.ppst"
function gameIdFromStateFile(name) {
  // format: <GAMEID>_<ver>_<slot>.<ext>
  // GAMEID is everything up to the second-to-last underscore group
  const m = name.match(/^([A-Z]{4}\d{5}(?:_\d+\.?\d*)?)/i);
  return m ? m[1] : name.replace(/\.[^.]+$/, "");
}

// Group a flat file map into slots for display
function groupSavesBySlot(fileMap) {
  const slots = new Map(); // key → { subdir, label, flat, slotDir, game, files[] }

  for (const PERSIST_ROOT of PERSIST_ROOTS) {
    for (const { dir, flat, label } of SAVE_SUBDIRS) {
      const prefix = PERSIST_ROOT + "/" + dir + "/";

      for (const [path, entry] of fileMap) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);

        if (flat) {
          // PPSSPP_STATE: files are flat — e.g. "ULES01384_1.00_0.ppst"
          // rest has no slash (direct file in the dir)
          if (rest.includes("/")) continue; // skip if nested (shouldn't happen)
          const game    = gameIdFromStateFile(rest);
          const slotDir = PERSIST_ROOT + "/" + dir; // the dir itself is the "slot"
          const key     = dir + "\0" + game;
          if (!slots.has(key)) slots.set(key, { dir, label, flat: true, slotDir, game, files: [] });
          slots.get(key).files.push({ name: rest, path, size: entry.size, data: entry.data });
        } else {
          // SAVEDATA: <game>/<filename>
          const slash = rest.indexOf("/");
          if (slash === -1) continue; // bare file at subdir root, skip
          const game = rest.slice(0, slash);
          const name = rest.slice(slash + 1);
          if (!name || name.includes("/")) continue;
          const slotDir = PERSIST_ROOT + "/" + dir + "/" + game;
          const key     = dir + "\0" + slotDir;
          if (!slots.has(key)) slots.set(key, { dir, label, flat: false, slotDir, game, files: [] });
          slots.get(key).files.push({ name, path, size: entry.size, data: entry.data });
        }
      }
    }
  }
  return [...slots.values()];
}

async function refreshSavesTab() {
  const empty  = document.getElementById("savesEmpty");
  const list   = document.getElementById("savesList");
  const stats  = document.getElementById("savesStats");
  if (!empty || !list) return;

  // Show spinner while loading
  empty.style.display = "block";
  empty.innerHTML = `<span class="saves-loading">正在读取存档…</span>`;
  list.style.display = "none";

  let fileMap;
  try { fileMap = await buildSaveFileMap(); }
  catch(e) { empty.innerHTML = "读取存档失败：" + esc(e.message); return; }

  const slots = groupSavesBySlot(fileMap);
  const fromFS  = !!window.FS;
  const source  = fromFS ? "当前游戏与本机存储" : "OPFS";

  if (!slots.length) {
    empty.style.display = "block";
    empty.innerHTML = "尚未找到存档。<br><small>请先在游戏内存档，再点击“同步存档到本机”。</small>";
    list.style.display = "none";
    if (stats) stats.textContent = "";
    return;
  }

  let totalSlots = 0, totalBytes = 0;

  // Separate save data vs save states
  const saveDataSlots  = slots.filter(s => !s.flat);
  const saveStateSlots = slots.filter(s =>  s.flat);

  let html = "";

  /* ── Save Data section ── */
  if (saveDataSlots.length) {
    const sdBytes = saveDataSlots.reduce((s, sl) => s + sl.files.reduce((a, f) => a + f.size, 0), 0);
    html += `<div class="save-section-label"><span>${svgIcon("save")} 游戏存档</span><span>${saveDataSlots.length} 个存档 · ${formatBytes(sdBytes)}</span></div>`;

    for (const { slotDir, game, files, flat } of saveDataSlots) {
      if (!files.length) continue;
      const slotBytes = files.reduce((s, f) => s + f.size, 0);
      totalSlots++; totalBytes += slotBytes;

      // Pick best thumbnail: ICON0.PNG > PIC1.PNG > first .png > first .jpg
      const byName = name => files.find(f => f.name.toUpperCase() === name);
      const thumbFile = byName("ICON0.PNG") || byName("PIC1.PNG") ||
                        files.find(f => /\.png$/i.test(f.name)) ||
                        files.find(f => /\.jpg$/i.test(f.name));
      const thumbExt  = thumbFile ? (thumbFile.name.split(".").pop() || "png") : "";
      const thumbURL  = thumbFile?.data ? toDataURL(thumbFile.data, thumbExt) : null;

      // Non-image files listed compactly
      const dataFiles = files.filter(f => !/\.(png|jpg|jpeg|bmp)$/i.test(f.name));
      const allPaths  = files.map(f => f.path);
      const fileSummary = dataFiles.map(f => f.name).join(" · ");

      html += `<div class="save-card">`;
      if (thumbURL) {
        html += `<img class="save-card-thumb" src="${thumbURL}" alt="存档封面" loading="lazy">`;
      } else {
        html += `<div class="save-card-thumb-placeholder">${svgIcon("save", "lucide save-ph-icon")}</div>`;
      }
      html += `<div class="save-card-body">`;
      html += `<div class="save-card-name" title="${esc(slotDir)}">${esc(game)}</div>`;
      html += `<div class="save-card-meta">${files.length} 个文件 &nbsp;·&nbsp; ${formatBytes(slotBytes)}</div>`;
      if (fileSummary) html += `<div class="save-card-files" title="${esc(fileSummary)}">${esc(fileSummary)}</div>`;
      html += `</div>`;
      html += `<div class="save-card-actions">`;
      html += `<button title="导出此存档" data-save-action="download-slot" data-slot-dir="${esc(slotDir)}" data-game="${esc(game)}">${svgIcon("download")}</button>`;
      html += `<button class="del" title="删除此存档" data-save-action="delete-slot" data-slot-dir="${esc(slotDir)}" data-game="${esc(game)}">${svgIcon("trash")}</button>`;
      html += `</div>`;
      html += `</div>`;
    }
  }

  /* ── Save States section ── */
  if (saveStateSlots.length) {
    // Flatten all state files across game groups
    const allStateFiles = [];
    for (const { slotDir, game, files, flat } of saveStateSlots) {
      for (const f of files) allStateFiles.push({ f, slotDir, game, flat });
    }
    const ssBytes = allStateFiles.reduce((s, { f }) => s + f.size, 0);
    html += `<div class="save-section-label save-section-spaced"><span>${svgIcon("gamepad")} 即时存档</span><span>${allStateFiles.length} 个文件 · ${formatBytes(ssBytes)}</span></div>`;

    // Pair .ppst/.sst with same-base .jpg thumbnail
    const stateByBase = new Map(); // base → { dataFile, thumbFile, slotDir, game, flat }
    for (const { f, slotDir, game, flat } of allStateFiles) {
      const dot  = f.name.lastIndexOf(".");
      const base = dot !== -1 ? f.name.slice(0, dot) : f.name;
      const ext  = dot !== -1 ? f.name.slice(dot + 1).toLowerCase() : "";
      if (!stateByBase.has(base)) stateByBase.set(base, { dataFile: null, thumbFile: null, slotDir, game, flat });
      if (ext === "jpg" || ext === "png") stateByBase.get(base).thumbFile = f;
      else stateByBase.get(base).dataFile = f;
    }

    for (const { dataFile, thumbFile, slotDir, game, flat } of stateByBase.values()) {
      const main = dataFile || thumbFile;
      if (!main) continue;
      totalSlots++; totalBytes += main.size + (thumbFile?.size || 0);
      const thumbURL = thumbFile?.data ? toDataURL(thumbFile.data, "jpg") : null;
      const allPaths = [main.path, ...(thumbFile && thumbFile !== main ? [thumbFile.path] : [])];
      const slotLabel = main.name.replace(/\.[^.]+$/, "");

      html += `<div class="save-state-row">`;
      if (thumbURL) {
        html += `<img class="save-state-thumb" src="${thumbURL}" alt="存档预览" loading="lazy">`;
      }
      html += `<div class="save-state-body">`;
      html += `<div class="save-state-name" title="${esc(main.path)}">${esc(slotLabel)}</div>`;
      html += `<div class="save-state-meta">${formatBytes(main.size)}</div>`;
      html += `</div>`;
      html += `<div class="save-state-actions">`;
      if (dataFile) html += `<button title="导出" data-save-action="download-file" data-path="${esc(dataFile.path)}">${svgIcon("download")}</button>`;
      html += `<button class="del" title="删除" data-save-action="delete-pair" data-paths="${esc(JSON.stringify(allPaths))}">${svgIcon("trash")}</button>`;
      html += `</div>`;
      html += `</div>`;
    }
  }

  empty.style.display = "none";
  list.style.display  = "block";
  list.innerHTML = html;
  if (stats) stats.textContent =
    totalSlots + " 个存档" +
    " · " + formatBytes(totalBytes) +
    " · 来源：" + source;
}

// Read file data from FS first, fallback to OPFS
async function readSaveFileData(path) {
  const FS = window.FS;
  if (FS) { try { return FS.readFile(path); } catch(e) {} }
  return opfsRead(path);
}

async function downloadSaveFile(path) {
  try {
    const data = await readSaveFileData(path);
    const name = path.split("/").pop();
    const blob = new Blob([data], { type: "application/octet-stream" });
    triggerDownload(blob, name);
    showToast("✓ 已导出 " + name);
  } catch(e) { showToast("操作未完成：" + e.message); }
}

async function downloadSaveSlot(slotDir, gameName) {
  // Collect all OPFS entries for this slot
  const all   = await opfsWalk();
  const files = all.filter(e => e.path.startsWith(slotDir + "/"));
  // Also grab any FS-only files not yet persisted
  const FS = window.FS;
  if (FS) {
    const fsFiles = readSaveSlotFiles(FS, slotDir);
    for (const { path } of fsFiles) {
      if (!files.find(e => e.path === path)) {
        try { files.push({ path, data: FS.readFile(path) }); } catch(e) {}
      }
    }
  }
  if (!files.length) { showToast("此存档目录中没有文件"); return; }
  const bundle = {
    version: 1, exported: new Date().toISOString(),
    slot: gameName, slotDir,
    files: files.map(({ path, data }) => ({
      name: path.split("/").pop(), path,
      data: bytesToBase64(data)
    }))
  };
  const blob = new Blob([JSON.stringify(bundle)], { type: "application/json" });
  triggerDownload(blob, "ppsspw-slot-" + gameName.replace(/[^a-zA-Z0-9_-]/g, "_") + ".ppsspp");
  log("Downloaded slot: " + gameName + " (" + files.length + " files)", "ok");
  showToast("✓ 已导出 " + gameName);
}

/* ── Individual Drive upload helpers ────────────────────────────── */
async function uploadSingleSaveSlotToDrive(slotDir, gameName) {
  if (!googleAccessToken) { showToast("⚠ Connect Google Drive first"); return; }
  try {
    setDriveActivity("Uploading slot " + gameName + "…", "run");
    if (window.FS) await persistFiles(window.FS, "drive-slot");
    await ensureDriveFolders(true);
    const all = await opfsWalk();
    const slotFiles = all.filter(e => e.path.startsWith(slotDir + "/"));
    const FS = window.FS;
    if (FS) {
      const fsFiles = readSaveSlotFiles(FS, slotDir);
      for (const { path } of fsFiles) {
        if (!slotFiles.find(e => e.path === path)) {
          try { slotFiles.push({ path, data: FS.readFile(path) }); } catch(e) {}
        }
      }
    }
    if (!slotFiles.length) { showToast("此存档目录中没有文件"); setDriveActivity("Idle"); return; }
    const bundle = {
      version: 1, exported: new Date().toISOString(),
      slot: gameName, slotDir,
      files: slotFiles.map(({ path, data }) => ({ name: path.split("/").pop(), path, data: bytesToBase64(data) }))
    };
    const bytes = new TextEncoder().encode(JSON.stringify(bundle));
    const remoteName = "ppsspp-slot-" + gameName.replace(/[^a-zA-Z0-9_-]/g, "_") + ".ppsspp";
    showLoading("Uploading " + remoteName + " to Drive…");
    await uploadBlobToDrive(remoteName, googleDriveSavesId, bytes, "application/json", "Uploading slot");
    log("Google Drive: uploaded slot " + gameName + " (" + slotFiles.length + " files).", "ok");
    setDriveActivity("Uploaded slot " + gameName, "ok");
    showToast("✓ Slot " + gameName + " uploaded to Drive");
    await refreshDriveList();
  } catch(e) {
    const message = googleAuthErrorMessage(e);
    log("Drive slot upload failed: " + message, "err");
    setDriveActivity("Slot upload failed: " + message, "bad");
    showToast("操作未完成：" + message, 5000);
  } finally { hideLoading(); }
}

async function uploadSingleSaveStateToDrive(paths, gameName) {
  if (!googleAccessToken) { showToast("⚠ Connect Google Drive first"); return; }
  try {
    setDriveActivity("Uploading state for " + gameName + "…", "run");
    if (window.FS) await persistFiles(window.FS, "drive-state");
    await ensureDriveFolders(true);
    const FS = window.FS;
    const fileEntries = [];
    for (const path of paths) {
      let data;
      try { data = await opfsRead(path); } catch(e) {
        if (FS) { try { data = FS.readFile(path); } catch(e2) {} }
      }
      if (data) fileEntries.push({ path, data });
    }
    if (!fileEntries.length) { showToast("No state files found"); setDriveActivity("Idle"); return; }
    const baseName = paths[0].split("/").pop().replace(/\.[^.]+$/, "");
    const bundle = {
      version: 1, exported: new Date().toISOString(),
      slot: gameName,
      files: fileEntries.map(({ path, data }) => ({ name: path.split("/").pop(), path, data: bytesToBase64(data) }))
    };
    const bytes = new TextEncoder().encode(JSON.stringify(bundle));
    const remoteName = "ppsspp-state-" + gameName.replace(/[^a-zA-Z0-9_-]/g, "_") + "-" + baseName + ".ppsspp";
    showLoading("Uploading " + remoteName + " to Drive…");
    await uploadBlobToDrive(remoteName, googleDriveSavesId, bytes, "application/json", "Uploading state");
    log("Google Drive: uploaded state " + remoteName + ".", "ok");
    setDriveActivity("Uploaded state " + baseName, "ok");
    showToast("✓ State " + baseName + " uploaded to Drive");
    await refreshDriveList();
  } catch(e) {
    const message = googleAuthErrorMessage(e);
    log("Drive state upload failed: " + message, "err");
    setDriveActivity("State upload failed: " + message, "bad");
    showToast("操作未完成：" + message, 5000);
  } finally { hideLoading(); }
}

async function uploadSingleGameToDrive(gameName) {
  if (!googleAccessToken) { showToast("⚠ Connect Google Drive first"); return; }
  try {
    setDriveActivity("Uploading game " + gameName + "…", "run");
    await ensureDriveFolders(true);
    showLoading("Uploading " + gameName + " to Drive…");
    const bytes = await opfsReadGame(gameName);
    await uploadBlobToDrive(gameName, googleDriveGamesId, bytes, "application/octet-stream", "Uploading game");
    log("Google Drive: uploaded game " + gameName + " (" + formatBytes(bytes.byteLength) + ").", "ok");
    setDriveActivity("Uploaded " + gameName + " to Drive", "ok");
    showToast("✓ " + gameName + " uploaded to Drive");
    await refreshDriveList();
  } catch(e) {
    const message = googleAuthErrorMessage(e);
    log("Drive game upload failed: " + message, "err");
    setDriveActivity("Game upload failed: " + message, "bad");
    showToast("操作未完成：" + message, 5000);
  } finally { hideLoading(); }
}

async function deleteSaveFile(path) {
  if (!confirm("删除文件：\n" + path.split("/").pop() + "?")) return;
  // Remove from OPFS
  try { await opfsDelete(path); } catch(e) {}
  // Remove from FS if running
  const FS = window.FS;
  if (FS) { try { FS.unlink(path); } catch(e) {} }
  showToast("已删除 " + path.split("/").pop());
  refreshSavesTab(); updateStorageInfo();
}

async function deleteSavePair(paths) {
  const names = paths.map(p => p.split("/").pop()).join("\n");
  if (!confirm("删除：\n" + names + "？\n\n删除后无法撤销。")) return;
  const FS = window.FS;
  for (const path of paths) {
    try { await opfsDelete(path); } catch(e) {}
    if (FS) { try { FS.unlink(path); } catch(e) {} }
  }
  showToast("已删除 " + paths.map(p => p.split("/").pop()).join(", "));
  refreshSavesTab(); updateStorageInfo();
}

async function deleteSaveSlot(slotDir, gameName) {
  if (!confirm("删除以下游戏的全部存档：\n" + gameName + "？\n\n删除后无法撤销。")) return;
  // Delete all OPFS entries under this slot
  const all   = await opfsWalk();
  const paths = all.filter(e => e.path.startsWith(slotDir + "/")).map(e => e.path);
  for (const path of paths) {
    try { await opfsDelete(path); } catch(e) {}
  }
  // Also remove from live FS
  const FS = window.FS;
  if (FS) {
    try {
      const files = readSaveSlotFiles(FS, slotDir);
      for (const { path } of files) { try { FS.unlink(path); } catch(e) {} }
      try { FS.rmdir(slotDir); } catch(e) {}
    } catch(e) {}
  }
  log("Deleted slot: " + gameName, "warn");
  showToast("已删除存档：" + gameName);
  refreshSavesTab(); updateStorageInfo();
}

function nativeSaveRelativePath(file) {
  const parts = (file.webkitRelativePath || "").split("/").filter(Boolean);
  if (parts.some(part => part === "." || part === ".." || part.includes("\\"))) throw new Error("存档文件夹路径无效");
  const savedata = parts.findIndex(part => part.toUpperCase() === "SAVEDATA");
  const relative = savedata >= 0 ? parts.slice(savedata + 1) : parts;
  if (relative.length < 2) throw new Error("请选择 SAVEDATA 或某个游戏的完整存档文件夹。");
  return relative.join("/");
}

function importNativeSaveFolder(files) {
  const selected = Array.from(files);
  const task = persistQueue.then(() => importNativeSaveFolderNow(selected));
  persistQueue = task.catch(() => {});
  return task;
}

async function importNativeSaveFolderNow(files) {
  if (!files.length) return;
  try {
    const paths = Array.from(files, file => ({ file, relative: nativeSaveRelativePath(file) }));
    const root = window.FS ? detectMemstickDir(window.FS) : PERSIST_ROOTS[0];
    const prepared = [];
    for (const { file, relative } of paths) {
      prepared.push({ relative, data: new Uint8Array(await file.arrayBuffer()) });
    }
    for (const { relative, data } of prepared) {
      const path = root + "/PSP/SAVEDATA/" + relative;
      await opfsPut(path, data);
      if (window.FS) {
        fsMkdirP(window.FS, dirname(path));
        window.FS.writeFile(path, data);
      }
    }
    log("Imported native PSP save folder: " + paths.length + " files.", "ok");
    showToast("已导入 " + paths.length + " 个 PSP 存档文件。");
    await refreshSavesTab();
    await updateStorageInfo();
  } catch (e) { showToast("导入存档文件夹失败：" + e.message, 6000); }
}
on("nativeSaveFolderInput", "change", async event => {
  await importNativeSaveFolder(event.target.files);
  event.target.value = "";
});

async function importSaveSlot(file) {
  try {
    const bundle = JSON.parse(await file.text());
    await importSavesBundle(bundle, bundle.slot || file.name);
  } catch(e) { log("Slot import error: " + e.message, "err"); showToast("导入失败：" + e.message); }
}

// Restore persisted files into Emscripten FS before PPSSPP starts
async function loadPersistedFiles(FS) {
  try {
    await rollbackSaveMigration(FS);
    const stored = await opfsRestoreEntries();
    if (!stored.length) { log("Persistence: no saved data in OPFS.", "dim"); return; }
    const { entries, skipped, skippedEntries } = selectPersistEntries(stored);
    // Read everything before changing either store. Starting with a partial
    // restore could let the game overwrite an unreadable but valid saved slot.
    const loaded = [];
    for (const entry of [...entries, ...skippedEntries]) {
      loaded.push({ ...entry, data: await opfsRead(entry.sourcePath, entry.handle) });
    }
    const selected = loaded.slice(0, entries.length);
    const migrated = selected.filter(entry => entry.legacy);
    let journal;
    try {
      // Journal only absent canonical targets. If rollback itself fails, the
      // next startup retries it before conflict selection can see a half slot.
      if (migrated.length) journal = await beginSaveMigration(migrated.map(entry => entry.path));
      for (const entry of selected) {
        const { path, data, legacy } = entry;
        if (legacy) await opfsPut(path, data);
        fsMkdirP(FS, path.substring(0, path.lastIndexOf("/")));
        // OPFS reads have private buffers. Keep legacy snapshots independent
        // of live writes until their asynchronous archive has committed.
        FS.writeFile(path, data, { canOwn: !legacy });
        if (!legacy) entry.data = null;
      }
      // Removing the journal commits the complete canonical copy. Only then
      // may legacy sources be archived and removed from the active save store.
      if (journal) await journal.removeEntry("save-migration.json");
    } catch (error) {
      if (migrated.length) {
        try { await rollbackSaveMigration(FS); }
        catch (rollbackError) { log("Migration rollback pending: " + rollbackError.message, "err"); }
      }
      throw error;
    }
    // Failure here must also block startup: otherwise the user could delete a
    // slot during play and its unarchived legacy copy would return next time.
    for (const entry of loaded) {
      if (entry.legacy) {
        await archiveLegacyPersistFile(entry.sourcePath, entry.data);
        entry.data = null;
      }
    }
    log("Persistence: restored " + selected.length + "/" + entries.length + " files from OPFS.", "ok");
    if (skipped) log("Persistence: kept current-root saves over " + skipped + " legacy-root files.", "info");
    showToast("✓ 已恢复 " + selected.length + " 个存档与设置文件");
    // Seed dirty-tracking so the first auto-sync cycle is fully incremental
    _detectedMemstick = detectMemstickDir(FS);
    const initStats = fsStatDir(FS, _detectedMemstick);
    for (const [path, { size, mtime }] of initStats)
      _persistedFileState.set(path, size + ":" + mtime);
  } catch(e) {
    log("Persistence: restore stopped: " + e.message, "err");
    const error = new Error("本机存档恢复未完成，已停止启动以保留原存档。请检查存储权限和空间后重新载入。" + "（" + e.message + "）");
    error.name = "SaveRestoreError";
    throw error;
  }
}

function patchIniValue(text, section, key, value, overwrite = true) {
  const lines = text ? text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n") : [];
  const sectionHeader = "[" + section + "]";
  const sectionRe = /^\s*\[([^\]]+)\]\s*$/;
  const keyRe = new RegExp("^\\s*" + key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*=");
  let sectionStart = -1;
  let sectionEnd = lines.length;

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(sectionRe);
    if (!match) continue;
    if (match[1] === section) {
      sectionStart = i;
      for (let j = i + 1; j < lines.length; j++) {
        if (sectionRe.test(lines[j])) { sectionEnd = j; break; }
      }
      break;
    }
  }

  if (sectionStart === -1) {
    if (lines.length && lines[lines.length - 1] !== "") lines.push("");
    lines.push(sectionHeader, key + " = " + value);
  } else {
    for (let i = sectionStart + 1; i < sectionEnd; i++) {
      if (keyRe.test(lines[i])) {
        if (!overwrite) return text;
        lines[i] = key + " = " + value;
        return lines.join("\n").replace(/\n*$/, "\n");
      }
    }
    lines.splice(sectionEnd, 0, key + " = " + value);
  }

  return lines.join("\n").replace(/\n*$/, "\n");
}

function loadPlayerSettings() {
  let saved = {};
  try { saved = JSON.parse(preferences.getItem(PLAYER_SETTINGS_KEY) || "{}"); } catch (_) {}
  return {
    resolution: [1, 2, 3].includes(Number(saved?.resolution)) ? Number(saved.resolution) : 1,
    showFps: saved?.showFps === true,
    touch: typeof saved?.touch === "boolean" ? saved.touch : isMobileExperience() || (navigator.maxTouchPoints || 0) > 0,
  };
}

function applyPlayerSettings(text, settings) {
  const values = [
    ["General", "Language", "zh_CN"],
    ["General", "CheckForNewVersion", "False"],
    ["General", "ReportingHost", ""],
    ["Achievements", "AchievementsEnable", "False"],
    ["Achievements", "AchievementsEnableRAIntegration", "False"],
    ["Graphics", "InternalResolution", String(settings.resolution)],
    ["Graphics", "iShowStatusFlags", settings.showFps ? "6" : "0"],
    ["Control", "ShowTouchControls", "False"],
    ["Network", "EnableWlan", "False"],
    ["Network", "EnableAdhocServer", "False"],
    ["Network", "EnableUPnP", "False"],
  ];
  for (const [section, key, value] of values) text = patchIniValue(text, section, key, value);
  return text;
}

function refreshPlayerSettingsUI() {
  const settings = loadPlayerSettings();
  const resolution = byId("player-render-resolution");
  const fps = byId("player-show-fps");
  const touch = byId("player-touch-controls");
  if (resolution) resolution.value = String(settings.resolution);
  if (fps) fps.checked = settings.showFps;
  if (touch) touch.checked = settings.touch;
  updateTouchControls();
}

let playerSettingsQueue = Promise.resolve();
let playerSettingsChanged = false;
async function resetPlayerSettings() {
  await playerSettingsQueue;
  const dir = await opfsDir(["player"], true);
  try {
    const file = await (await dir.getFileHandle("settings.json")).getFile();
    await writeOpfsHandle(await dir.getFileHandle("settings.recovery-backup", { create: true }), await file.text());
    await dir.removeEntry("settings.json");
  } catch (error) { if (error.name !== "NotFoundError") throw error; }
  preferences.removeItem(PLAYER_SETTINGS_KEY);
  playerSettingsChanged = true;
  refreshPlayerSettingsUI();
}

async function restorePlayerSettings() {
  if (playerSettingsChanged || !hasOPFS()) return;
  try {
    const dir = await opfsDir(["player"], false);
    const file = await (await dir.getFileHandle("settings.json")).getFile();
    const text = await file.text();
    JSON.parse(text);
    if (!playerSettingsChanged) preferences.setItem(PLAYER_SETTINGS_KEY, text);
  } catch (error) {
    if (error.name !== "NotFoundError") log("Player settings restore: " + error.message, "warn");
  }
  refreshPlayerSettingsUI();
}

function savePlayerSettings(event) {
  const settings = {
    resolution: Number(byId("player-render-resolution")?.value || 1),
    showFps: !!byId("player-show-fps")?.checked,
    touch: !!byId("player-touch-controls")?.checked,
  };
  if (![1, 2, 3].includes(settings.resolution)) settings.resolution = 1;
  playerSettingsChanged = true;
  preferences.setItem(PLAYER_SETTINGS_KEY, JSON.stringify(settings));
  if (event?.target?.id === "player-touch-controls" && settings.touch && gamepadBridgeRawIndex >= 0)
    setActiveGamepadIndex(-1, "screen controls");
  updateTouchControls();
  const task = playerSettingsQueue.then(async () => {
    const status = byId("player-settings-status");
    try {
      if (!hasOPFS()) throw new Error("浏览器未开放本地存储权限");
      const dir = await opfsDir(["player"], true);
      await writeOpfsHandle(await dir.getFileHandle("settings.json", { create: true }), JSON.stringify(settings));
      // The launcher owns this file only. Native INIs are patched immediately
      // before startup, avoiding races with the running core's persistence.
      if (status) status.textContent = started
        ? "屏幕手柄设置已立即生效；画质与帧率显示下次启动生效。请先在游戏内存档并同步到本机，再自行重新载入页面。"
        : "设置已保存，将在启动时生效。";
    } catch (error) {
      log("Player settings persistence failed: " + error.message, "warn");
      if (status) status.textContent = "本地保存未完成，当前页面仍会使用这些设置。请检查网站存储权限。";
    }
  });
  playerSettingsQueue = task.catch(() => {});
  return task;
}

async function syncPlayerFiles() {
  if (!runtimeReady || !window.FS) { showToast("请先启动游戏，再同步游戏已生成的存档。"); return; }
  try {
    const result = await persistFiles(window.FS, "manual");
    if (result?.unavailable) throw new Error("浏览器未开放本地存储权限");
    if (result?.failed) throw new Error("部分文件未能写入，请检查存储空间后重试");
    showToast("已同步到本机。此操作保存游戏已生成的存档，不会替代游戏内存档。", 6000);
    await refreshSavesTab();
  } catch (error) {
    log("Manual persistence failed: " + error.message, "err");
    showToast("存档同步未完成，请保留当前页面并重试。可先导出存档备份。", 7000);
  }
}

function returnToGameCanvas() {
  if (!runtimeReady) { showToast("请先启动游戏。"); return; }
  setPanelOpen(false, false);
  setFullscreenMenuOpen(false, false);
  canvas?.focus({ preventScroll: true });
  void unlockAudio();
}

function openCoreMenu() {
  if (!runtimeReady || !canvas) { showToast("请先启动游戏。"); return; }
  returnToGameCanvas();
  for (const type of ["keydown", "keyup"]) {
    canvas.dispatchEvent(new KeyboardEvent(type, {
      key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true,
    }));
  }
  showToast("已发送菜单键。请在模拟器菜单中选择继续游戏；这不是 PSP 的 START 键。", 5000);
}

function defaultNetworkServerHost() {
  const host = location.hostname || "127.0.0.1";
  return host === "localhost" ? "127.0.0.1" : host;
}

function normalizeNetworkServerHost(value) {
  let host = String(value || "").trim();
  if (!host) return defaultNetworkServerHost();

  try {
    const parsed = new URL(host.includes("://") ? host : "ws://" + host);
    host = parsed.hostname || host;
  } catch(e) {
    host = host.split(/[/?#]/, 1)[0];
    if (host.startsWith("[") && host.includes("]")) {
      host = host.slice(1, host.indexOf("]"));
    } else {
      host = host.replace(/:\d+$/, "");
    }
  }

  host = host.trim();
  return host || defaultNetworkServerHost();
}

function browserRelayServerHost() {
  return normalizeNetworkServerHost(defaultNetworkServerHost());
}

function randomPspMac() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  bytes[0] = (bytes[0] & 0xFE) | 0x02;
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join(":");
}

function sanitizeNetworkNick(value) {
  const clean = String(value || "WebPlayer").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 16);
  return clean.length >= 3 ? clean : "WebPlayer";
}

function sanitizeNetworkMac(value) {
  const clean = String(value || "").trim().toLowerCase();
  return /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(clean) && !(parseInt(clean.slice(0, 2), 16) & 1) && clean !== "00:00:00:00:00:00" ? clean : randomPspMac();
}

function readNetworkSessionKey() {
  try { return sessionStorage.getItem("ppsspp-relay-session-key") || networkSessionKey; }
  catch (_) { return networkSessionKey; }
}

function storeNetworkSessionKey(value) {
  networkSessionKey = value;
  try { sessionStorage.setItem("ppsspp-relay-session-key", value); } catch (_) {}
}

function loadNetworkConfig() {
  let mac = preferences.getItem(NETWORK_MAC_KEY);
  if (!mac || !/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(mac) || parseInt(mac.slice(0, 2), 16) & 1) {
    mac = randomPspMac(); preferences.setItem(NETWORK_MAC_KEY, mac);
  }
  // Separate tabs need separate PSP identities; keep this tab's identity on reload.
  try {
    let tabMac = sessionStorage.getItem("ppsspp-tab-mac");
    if (!tabMac) { tabMac = randomPspMac(); sessionStorage.setItem("ppsspp-tab-mac", tabMac); }
    mac = tabMac;
  } catch (_) {}
  let server = preferences.getItem(NETWORK_SERVER_KEY);
  if (!server || !server.includes("://")) server = new URL("/adhoc", location.href).href.replace(/^http/, "ws");
  return { enabled: !LOCAL_ONLY && preferences.getItem(NETWORK_ENABLE_KEY) === "1", server,
    room: preferences.getItem("ppsspp-network-room") || "public",
    sessionKey: readNetworkSessionKey(),
    nick: sanitizeNetworkNick(preferences.getItem(NETWORK_NICK_KEY)), mac: sanitizeNetworkMac(mac) };
}

function importNetworkInvite(hash = location.hash, strict = false) {
  const invite = new URLSearchParams(hash.slice(1));
  if (!invite.get("relay")) { if (strict) throw new Error("Invalid multiplayer invitation"); return; }
  try {
    const server = window.PPSSPPAdhoc.endpoint(invite.get("relay")).href;
    const room = invite.get("room") || "public";
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(room)) throw new Error("Invalid invitation room");
    const sameRelay = preferences.getItem(NETWORK_SERVER_KEY) === server;
    const sessionKey = invite.has("session_key") ? invite.get("session_key") : sameRelay ? readNetworkSessionKey() : "";
    if (sessionKey.length > 256) throw new Error("Invalid session key");
    storeNetworkSessionKey(sessionKey);
    preferences.setItem(NETWORK_SERVER_KEY, server);
    preferences.setItem("ppsspp-network-room", room);
    preferences.setItem(NETWORK_ENABLE_KEY, "1");
    history.replaceState(null, "", location.pathname + location.search);
  } catch (e) { if (strict) throw e; log("Network invitation: " + e.message, "warn"); }
}

function testWebSocket(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { ws.close(); } catch(e) {}
      reject(new Error("timeout"));
    }, timeoutMs);
    let ws;
    try {
      ws = new WebSocket(url, "binary");
      ws.binaryType = "arraybuffer";
      ws.onopen = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        ws.close();
        resolve();
      };
      ws.onclose = ws.onerror = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(new Error("connection failed; check relay URL, session key and TLS certificate"));
      };
    } catch(e) {
      clearTimeout(timer);
      reject(e);
    }
  });
}

function networkConfigSignature(cfg) {
  return JSON.stringify([cfg.enabled, cfg.server, cfg.room, cfg.sessionKey, cfg.nick, cfg.mac]);
}

function networkStatusView(cfg, live, probe, now = Date.now(), online = true) {
  if (!online) return { tone: "error", title: "You are offline", detail: "Restore your internet or LAN connection, then check the relay again." };
  if (live?.lastError) return { tone: "error", title: "Connection problem", detail: live.lastError + ". Check your relay address, session key and certificate; then reconnect from the game's multiplayer menu." };
  if (live?.state === "registered") {
    const count = live.peers?.length || 0;
    return { tone: "good", title: count ? "Connected with friends" : "Connected to relay", detail: count ? `${count} player${count === 1 ? "" : "s"} connected. Use the game's multiplayer menu to play.` : "Game connection active. Host or join a session in the game's multiplayer menu." };
  }
  if (live?.state === "connecting") return { tone: "busy", title: "Connecting game…", detail: "Waiting for the relay to accept the game connection." };
  if (probe.state === "checking") return { tone: "busy", title: "Checking relay…", detail: "Verifying the WebSocket connection and your access key." };
  if (probe.state === "error") return { tone: "error", title: "Relay unreachable", detail: probe.error };
  if (probe.state === "reachable" && now - probe.checkedAt < 30000) return { tone: "ready", title: "Relay reachable · game not connected", detail: "Relay accepted the connection. Start the emulator and enter the game's multiplayer menu to connect." };
  if (live?.state === "disconnected") return { tone: "neutral", title: "Disconnected", detail: "The game has no active relay connection. Leave and re-enter the game's multiplayer menu to reconnect." };
  if (!cfg.enabled) return { tone: "neutral", title: "Multiplayer disabled", detail: "Enable multiplayer and save your settings before starting the emulator." };
  return { tone: "neutral", title: "Connection not checked", detail: "Check the relay before playing. The game connects when you enter its multiplayer menu." };
}

function renderNetworkStatus(cfg = loadNetworkConfig()) {
  // Event listeners pass an Event; only configuration objects belong here.
  if (!cfg || typeof cfg.enabled !== "boolean") cfg = loadNetworkConfig();
  const view = networkStatusView(cfg, networkLiveStatus, networkProbe, Date.now(), navigator.onLine !== false);
  const card = byId("networkStatus");
  if (card) card.dataset.tone = view.tone;
  if (byId("networkStatusTitle")) byId("networkStatusTitle").textContent = view.title;
  if (byId("networkStatusDetail")) byId("networkStatusDetail").textContent = view.detail;
  const live = networkLiveStatus;
  const session = byId("networkSessionState");
  if (session) session.textContent = live?.state === "registered"
    ? `Room: ${networkActiveConfig?.room || cfg.room} · ${live.peers?.length || 0} peers` + (live.rttMs == null ? "" : ` · ${live.rttMs} ms`)
    : "No active game session";
  if (networkActiveConfig && networkConfigSignature(cfg) !== networkConfigSignature(networkActiveConfig)) {
    if (session) session.textContent += " · Saved settings changed: restart the emulator to apply";
  }
  if (networkTestBtn) { networkTestBtn.disabled = networkProbe.state === "checking"; networkTestBtn.setAttribute("aria-busy", String(networkProbe.state === "checking")); }
  if (byId("networkDisconnectBtn")) byId("networkDisconnectBtn").disabled = !["registered", "connecting"].includes(live?.state);
  if (byId("networkReconnectBtn")) byId("networkReconnectBtn").disabled = !window.ppssppAdhocTransport || live?.state === "connecting";
}

function checkNetworkWhenVisible() {
  if (LOCAL_ONLY) return;
  if (document.hidden || !document.body.classList.contains("panel-open") || !byId("tabNetwork")?.classList.contains("active")) return;
  renderNetworkStatus();
  if (networkDraftDirty || !loadNetworkConfig().enabled || networkLiveStatus?.state === "registered" || networkLiveStatus?.state === "connecting") return;
  if (networkProbe.state === "checking" || Date.now() - (networkProbe.checkedAt || 0) < 30000) return;
  testNetworkRelay(false);
}

async function testNetworkRelay(save = true) {
  if (LOCAL_ONLY) return;
  let probe;
  try {
    if (networkProbe.state === "checking") return;
    const cfg = save === false ? loadNetworkConfig() : saveNetworkConfigFromUI();
    probe = { state: "checking" };
    networkProbe = probe;
    renderNetworkStatus(cfg);
    const base = window.PPSSPPAdhoc.endpoint(cfg.server);
    const token = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, "0")).join("");
    base.search = new URLSearchParams({ v: "1", token, room: cfg.room, ...(cfg.sessionKey ? { session_key: cfg.sessionKey } : {}) });
    await testWebSocket(base.href);
    if (networkProbe !== probe) return;
    networkProbe = { state: "reachable", checkedAt: Date.now() };
  } catch (e) {
    if (probe && networkProbe !== probe) return;
    networkProbe = { state: "error", error: "Relay check failed: " + e.message, checkedAt: Date.now() };
  }
  renderNetworkStatus();
}

function saveNetworkConfigFromUI() {
  const cfg = { enabled: !!networkEnableToggle?.checked,
    server: window.PPSSPPAdhoc.endpoint(networkServerInput?.value).href.replace(/\/$/, ""),
    room: byId("networkRoomInput")?.value.trim() || "public",
    sessionKey: byId("networkSessionKeyInput")?.value || "",
    nick: sanitizeNetworkNick(networkNickInput?.value), mac: sanitizeNetworkMac(networkMacInput?.value) };
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(cfg.room)) throw new Error("Room: use 1–32 letters, numbers, _ or -");
  if (cfg.sessionKey.length > 256) throw new Error("Session key too long");
  if (networkConfigSignature(cfg) !== networkConfigSignature(loadNetworkConfig())) networkProbe = { state: "unverified" };
  storeNetworkSessionKey(cfg.sessionKey);
  preferences.setItem(NETWORK_ENABLE_KEY, cfg.enabled ? "1" : "0");
  preferences.setItem(NETWORK_SERVER_KEY, cfg.server);
  preferences.setItem(NETWORK_NICK_KEY, cfg.nick);
  preferences.setItem(NETWORK_MAC_KEY, cfg.mac);
  preferences.setItem("ppsspp-network-room", cfg.room);
  try { sessionStorage.setItem("ppsspp-tab-mac", cfg.mac); } catch (_) {}
  updateNetworkConfigUI(cfg, "Saved. Restart the emulator to apply network settings before entering multiplayer.");
  return cfg;
}

function updateNetworkConfigUI(cfg = loadNetworkConfig(), message = "") {
  networkDraftDirty = false;
  if (networkEnableToggle) networkEnableToggle.checked = cfg.enabled;
  if (networkServerInput) networkServerInput.value = cfg.server;
  if (networkNickInput) networkNickInput.value = cfg.nick;
  if (networkMacInput) networkMacInput.value = cfg.mac;
  if (byId("networkRoomInput")) byId("networkRoomInput").value = cfg.room;
  if (byId("networkSessionKeyInput")) byId("networkSessionKeyInput").value = cfg.sessionKey || "";
  renderNetworkStatus(cfg);
  if (networkActivityEl && message) networkActivityEl.textContent = message;
}

function installSockFSAdhocRelay() {
  if (!loadNetworkConfig().enabled) return true;
  try {
    networkActiveConfig = loadNetworkConfig();
    window.ppssppAdhocTransport = window.PPSSPPAdhoc.install({
      SOCKFS: window.SOCKFS || window.Module?.SOCKFS,
      FS: window.FS || window.Module?.FS,
      config: { ...loadNetworkConfig(), endpoint: loadNetworkConfig().server },
      onstatus(status) {
        const node = byId("networkDiagnostics");
        if (node) node.textContent = JSON.stringify(status, null, 2);
        networkLiveStatus = status;
        renderNetworkStatus();
      },
    });
    return true;
  } catch (error) {
    networkLiveStatus = { state: "disconnected", lastError: error.message };
    renderNetworkStatus();
    log("Network: " + error.message, "err");
    return false;
  }
}

async function applyNetworkConfig(FS, text) {
  const cfg = loadNetworkConfig();
  let patched = text;
  patched = patchIniValue(patched, "Network", "EnableWlan", cfg.enabled ? "True" : "False");
  patched = patchIniValue(patched, "Network", "proAdhocServer", "relay.ppsspp.invalid");
  patched = patchIniValue(patched, "Network", "AdhocServerRelayMode", "2");
  patched = patchIniValue(patched, "Network", "EnableAdhocServer", "False");
  patched = patchIniValue(patched, "Network", "ForcedFirstConnect", "True");
  patched = patchIniValue(patched, "Network", "PortOffset", "10000");
  patched = patchIniValue(patched, "Network", "MinTimeout", "1");
  patched = patchIniValue(patched, "Network", "EnableUPnP", "False");
  patched = patchIniValue(patched, "SystemParam", "NickName", cfg.nick);
  patched = patchIniValue(patched, "SystemParam", "MacAddress", cfg.mac);
  patched = patchIniValue(patched, "SystemParam", "WlanAdhocChannel", "0");

  return patched;
}

function applyMultiplayerTimingConfig(text) {
  if (!loadNetworkConfig().enabled) return text;
  // Native lag-sync sleeps block delivery of browser relay messages.
  return patchIniValue(text, "General", "ForceLagSync2", "False");
}

async function forceGamesDirectoryConfig(FS) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const applyMobileTouchDefaults = isMobileExperience();

  for (const root of PERSIST_ROOTS) {
    const iniPath = root + "/PSP/SYSTEM/ppsspp.ini";
    try {
      fsMkdirP(FS, root + "/PSP/SYSTEM");
      let text = "";
      try { text = decoder.decode(FS.readFile(iniPath)); } catch(e) {}
      let patched = patchIniValue(text, "General", "CurrentDirectory", VIRTUAL_GAME_DIR);
      patched = await applyNetworkConfig(FS, patched);
      for (const [section, key, value] of WEB_NATIVE_TIMING_CONFIG) {
        patched = patchIniValue(patched, section, key, value, false);
      }
      for (const [section, key, value] of WEB_STABILITY_CONFIG) {
        patched = patchIniValue(patched, section, key, value, false);
      }
      patched = applyMultiplayerTimingConfig(patched);
      if (applyMobileTouchDefaults) {
        for (const [section, key, value] of MOBILE_TOUCH_CONFIG) {
          patched = patchIniValue(patched, section, key, value, false);
        }
      }
      patched = applyPlayerSettings(patched, loadPlayerSettings());
      const bytes = encoder.encode(patched);
      FS.writeFile(iniPath, bytes);
      await opfsPut(iniPath, bytes);
      // This native option is also per-game. An imported override must not draw
      // a second controller underneath the browser's screen controls.
      const systemDir = root + "/PSP/SYSTEM";
      for (const name of FS.readdir(systemDir)) {
        if (!name.endsWith("_ppsspp.ini")) continue;
        const gameIniPath = systemDir + "/" + name;
        const gameText = decoder.decode(FS.readFile(gameIniPath));
        if (!/^\s*ShowTouchControls\s*=/m.test(gameText)) continue;
        const gamePatched = patchIniValue(gameText, "Control", "ShowTouchControls", "False");
        if (gamePatched === gameText) continue;
        const gameBytes = encoder.encode(gamePatched);
        FS.writeFile(gameIniPath, gameBytes);
        await opfsPut(gameIniPath, gameBytes);
      }
      log("Config: missing web defaults initialized at " + iniPath + (applyMobileTouchDefaults ? " (mobile touch/UI enabled)" : ""), "ok");
    } catch(e) {
      log("Config: failed to apply web defaults at " + iniPath + ": " + e.message, "warn");
    }
  }
}

// Save config+saves from Emscripten FS to OPFS — incremental (only changed/deleted files)
let persistQueue = Promise.resolve();
function persistFiles(FS, label) {
  const task = persistQueue.then(() => persistFilesNow(FS, label));
  persistQueue = task.catch(e => log("Persistence failed: " + e.message, "warn"));
  return task;
}

async function persistFilesNow(FS, label) {
  if (!FS || !hasOPFS()) return { unavailable: true };
  _detectedMemstick = detectMemstickDir(FS);
  const currentStats = fsStatDir(FS, _detectedMemstick);

  if (!currentStats.size) {
    log("Persistence" + (label ? " [" + label + "]" : "") + ": nothing at " + _detectedMemstick, "dim");
    updateStorageInfo(); return { written: 0, removed: 0, failed: 0 };
  }

  // Collect files whose size or mtime has changed since last persist
  const dirty = [];
  for (const [path, { size, mtime }] of currentStats) {
    const fp = size + ":" + mtime;
    if (_persistedFileState.get(path) !== fp) dirty.push({ path, fp });
  }

  // Collect files that were persisted but no longer exist in FS
  const deleted = [];
  for (const path of _persistedFileState.keys()) {
    if (!currentStats.has(path)) deleted.push(path);
  }

  if (!dirty.length && !deleted.length) {
    log("Persistence [" + (label || "auto") + "]: up-to-date, nothing to sync.", "dim");
    return { written: 0, removed: 0, failed: 0 };
  }

  let written = 0, removed = 0, failed = 0;
  try {
    for (const { path, fp } of dirty) {
      try {
        const data = FS.readFile(path);
        await opfsPut(path, data);
        _persistedFileState.set(path, fp);
        written++;
      } catch(e) { failed++; log("Persist write failed " + path + ": " + e.message, "warn"); }
    }
    for (const path of deleted) {
      try { await opfsDelete(path); }
      catch(e) {
        if (e.name !== "NotFoundError") {
          log("Persist delete failed " + path + ": " + e.message, "warn");
          failed++;
          continue;
        }
      }
      _persistedFileState.delete(path);
      removed++;
    }
    if (!failed) _lastPersistTime = Date.now();
    const parts = [];
    if (written) parts.push(written + " written");
    if (removed) parts.push(removed + " removed");
    log("Persistence [" + (label || "manual") + "]: " + parts.join(", ") +
        " of " + currentStats.size + " total files.", "ok");
    updateStorageInfo();
  } catch(e) { failed++; log("Persistence: OPFS write error: " + e.message, "warn"); }
  return { written, removed, failed };
}

function startAutoPersist() {
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && runtimeReady && window.FS) void persistFiles(window.FS, "background");
  });
  setInterval(() => {
    const FS = window.FS;
    if (!runtimeReady || !FS) return;
    persistFiles(FS, "auto");
  }, PERSIST_SYNC_MS);
}

/* ── Drive auto-sync ─────────────────────────────────────────────── */
let _driveAutoSyncTimer = null;
let _driveAutoSyncLastAt = 0;

function driveAutoSyncEnabled() {
  return preferences.getItem(GOOGLE_AUTO_SYNC_KEY) === "1";
}

function driveAutoSyncRate() {
  return Math.max(60, Number(preferences.getItem(GOOGLE_AUTO_SYNC_RATE_KEY) || 300));
}

function updateDriveAutoSyncUI() {
  const toggle   = document.getElementById("driveAutoSyncToggle");
  const interval = document.getElementById("driveAutoSyncInterval");
  const status   = document.getElementById("driveAutoSyncStatus");
  if (!toggle || !interval) return;
  const enabled = driveAutoSyncEnabled();
  const connected = !!googleAccessToken;
  toggle.checked = enabled;
  toggle.disabled = !connected;
  interval.disabled = !enabled || !connected;
  interval.value = String(driveAutoSyncRate());
  if (!connected) {
    if (status) status.textContent = "Connect Drive to use auto-sync";
    interval.disabled = true;
  } else if (!enabled) {
    if (status) status.textContent = "";
  } else {
    const rateMin = Math.round(driveAutoSyncRate() / 60);
    const lastAgo = _driveAutoSyncLastAt
      ? Math.round((Date.now() - _driveAutoSyncLastAt) / 1000) + "s ago"
      : "never";
    if (status) status.textContent = "Last: " + lastAgo;
  }
}

async function runDriveAutoSync() {
  if (!googleAccessToken || !driveAutoSyncEnabled() || !started) return;
  if (activeDriveAction) return; // don't overlap a manual action
  try {
    if (driveBadgeEl) driveBadgeEl.classList.add("syncing");
    if (driveBadgeText) driveBadgeText.textContent = "Syncing…";
    setDriveActivity("Auto-sync: uploading saves…", "run");
    if (window.FS) await persistFiles(window.FS, "drive-auto");
    await ensureDriveFolders(true);
    const bundle = await buildSavesBundle();
    if (bundle) {
      const bytes = new TextEncoder().encode(JSON.stringify(bundle));
      await uploadBlobToDrive(GOOGLE_DRIVE_SAVE_BUNDLE, googleDriveSavesId, bytes, "application/json", "Auto-sync saves");
      log("Drive auto-sync: uploaded saves bundle (" + bundle.files.length + " files).", "ok");
    }
    _driveAutoSyncLastAt = Date.now();
    setDriveActivity("Auto-sync complete: " + new Date().toLocaleTimeString(), "ok");
    if (driveBadgeText) driveBadgeText.textContent = "Drive ✓";
    setTimeout(() => { if (driveBadgeText && googleAccessToken) driveBadgeText.textContent = "Drive"; }, 3000);
  } catch(e) {
    const message = googleAuthErrorMessage(e);
    log("Drive auto-sync failed: " + message, "warn");
    setDriveActivity("Auto-sync failed: " + message, "bad");
    if (driveBadgeText) driveBadgeText.textContent = "Drive ✗";
    setTimeout(() => { if (driveBadgeText && googleAccessToken) driveBadgeText.textContent = "Drive"; }, 4000);
  } finally {
    if (driveBadgeEl) driveBadgeEl.classList.remove("syncing");
    updateDriveAutoSyncUI();
  }
}

function restartDriveAutoSyncTimer() {
  if (_driveAutoSyncTimer) { clearInterval(_driveAutoSyncTimer); _driveAutoSyncTimer = null; }
  if (LOCAL_ONLY) return;
  if (!driveAutoSyncEnabled() || !googleAccessToken) { updateDriveAutoSyncUI(); return; }
  const ms = driveAutoSyncRate() * 1000;
  _driveAutoSyncTimer = setInterval(runDriveAutoSync, ms);
  log("Drive auto-sync enabled: every " + Math.round(ms / 60000) + " min.", "ok");
  updateDriveAutoSyncUI();
}

/* ── Export / Import saves ──────────────────────────────────────── */
async function buildSavesBundle() {
  const FS = window.FS;
  const root  = FS ? detectMemstickDir(FS) : (_detectedMemstick || PERSIST_ROOTS[0]);
  const files = FS ? fsWalkDir(FS, root) : await opfsWalk();
  if (!files.length) return null;
  return {
    version: 1,
    exported: new Date().toISOString(),
    ppssppMemstick: root,
    files: files.map(({ path, data }) => ({
      path,
      data: bytesToBase64(data)
    }))
  };
}

async function exportSaves() {
  try {
  const bundle = await buildSavesBundle();
  if (!bundle) { showToast("暂无可以导出的存档。"); return; }
  const blob = new Blob([JSON.stringify(bundle)], { type: "application/json" });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement("a"), {
    href: url, download: "ppsspw-saves-" + new Date().toISOString().slice(0, 10) + ".ppsspp"
  });
  a.click(); URL.revokeObjectURL(url);
  log("Exported " + bundle.files.length + " files.", "ok");
  showToast("✓ 已导出 " + bundle.files.length + " 个文件");
  } catch (error) {
    log("Save export failed: " + error.message, "err");
    showToast("导出存档失败，请保留当前页面并重试。错误详情已记录。", 6000);
  }
}

function importSavesBundle(bundle, label) {
  const task = persistQueue.then(() => importSavesBundleNow(bundle, label));
  persistQueue = task.catch(() => {});
  return task;
}

async function importSavesBundleNow(bundle, label) {
  const FS = window.FS;
  if (!Array.isArray(bundle?.files)) throw new Error("存档包格式不正确");
  const existing = (await opfsWalk(OPFS_PERSIST_DIR, "", false)).map(file => file.path);
  if (FS) existing.push(...fsStatDir(FS, detectMemstickDir(FS)).keys());
  const { entries, skipped } = selectPersistEntries(bundle.files, existing);
  // Decode the whole selected backup before replacing any existing file.
  const decoded = entries.map(entry => ({ ...entry, bytes: base64ToBytes(entry.data) }));
  let count = 0;
  for (const { path, bytes } of decoded) {
    await opfsPut(path, bytes);
    if (FS) {
      fsMkdirP(FS, path.substring(0, path.lastIndexOf("/")));
      FS.writeFile(path, bytes);
    }
    count++;
  }
  log("已导入 " + count + " files from " + label, "ok");
  showToast("✓ 已导入 " + count + " 个存档文件" + (skipped ? "；保留已有存档，跳过 " + skipped + " 个旧目录文件。" : ""), skipped ? 6500 : 3200);
  refreshSavesTab(); updateStorageInfo();
  return count;
}

async function importSaves(file) {
  try {
    const bundle = JSON.parse(await file.text());
    await importSavesBundle(bundle, file.name);
  } catch(e) { log("Import error: " + e.message, "err"); showToast("导入失败：" + e.message); }
}

/* ── Google Drive sync (100% client side) ───────────────────────── */
let googleTokenClient = null;
let googleAccessToken = "";
let googleTokenExpiresAt = 0;
let googleDriveRootId = "";
let googleDriveSavesId = "";
let googleDriveGamesId = "";
let googleDriveRemoteCache = { saves: [], games: [] };
let activeDriveAction = "";

function googleClientId() {
  return (window.PPSSPP_GOOGLE_CLIENT_ID || preferences.getItem(GOOGLE_CLIENT_ID_KEY) || "").trim();
}

function googleRedirectUri() {
  return location.origin + location.pathname;
}

function shouldUseRedirectOAuth() {
  return true;
}

function googleAuthErrorMessage(error) {
  const msg = String(error?.message || error || "Google login failed");
  if (/timed out/i.test(msg)) return "Google login timed out. Try again, or check that popups and redirects are allowed.";
  if (/popup|closed|cancel/i.test(msg)) return "Google login was closed before it completed.";
  if (/redirect_uri_mismatch/i.test(msg)) return "Google rejected the redirect URI. Add this URL in Google Cloud: " + googleRedirectUri();
  if (/idpiframe|third.?party|cookie/i.test(msg)) return "Google login was blocked by browser privacy settings. Try redirect login or allow third-party cookies for Google.";
  return msg;
}

function setGoogleToken(token, expiresIn) {
  googleAccessToken = token || "";
  googleTokenExpiresAt = googleAccessToken ? Date.now() + Number(expiresIn || 3600) * 1000 : 0;
  if (googleAccessToken) {
    preferences.setItem(GOOGLE_TOKEN_KEY, JSON.stringify({
      accessToken: googleAccessToken,
      expiresAt: googleTokenExpiresAt,
    }));
  } else {
    preferences.removeItem(GOOGLE_TOKEN_KEY);
  }
}

function restoreGoogleToken() {
  if (googleAccessToken && Date.now() < googleTokenExpiresAt - 60000) return true;
  let saved = null;
  try { saved = JSON.parse(preferences.getItem(GOOGLE_TOKEN_KEY) || "null"); } catch(e) {}
  if (!saved?.accessToken || !saved?.expiresAt || Date.now() >= Number(saved.expiresAt) - 60000) {
    preferences.removeItem(GOOGLE_TOKEN_KEY);
    return false;
  }
  googleAccessToken = saved.accessToken;
  googleTokenExpiresAt = Number(saved.expiresAt);
  setDriveInfo("Connected", "good");
  return true;
}

function handleGoogleRedirectCallback() {
  if (!location.hash.includes("access_token=") && !location.hash.includes("error=")) return false;
  const params = new URLSearchParams(location.hash.slice(1));
  const token = params.get("access_token");
  const error = params.get("error");
  const state = params.get("state") || "";
  const expectedState = preferences.getItem(GOOGLE_OAUTH_STATE_KEY) || "";
  preferences.removeItem(GOOGLE_OAUTH_STATE_KEY);
  history.replaceState(null, document.title, location.pathname + location.search);

  if (error) {
    takePendingDriveAction();
    setDriveActivity("Connect failed: " + googleAuthErrorMessage(error), "bad");
    return true;
  }
  if (!token) return true;
  if (expectedState && state !== expectedState) {
    takePendingDriveAction();
    setDriveActivity("Connect failed: OAuth state mismatch", "bad");
    return true;
  }

  setGoogleToken(token, params.get("expires_in") || 3600);
  setDriveInfo("Connected", "good");
  const pendingAction = takePendingDriveAction();
  setDriveActivity(pendingAction ? "Google connected. Resuming Drive action…" : "Google connected. Reading Drive…", "run");
  showToast("Google Drive connected");
  if (pendingAction) {
    resumePendingDriveAction(pendingAction);
  } else {
    setTimeout(() => refreshDriveList().catch(e => {
      const message = googleAuthErrorMessage(e);
      log("Google Drive refresh failed after login: " + message, "err");
      setDriveActivity("Refresh failed: " + message, "bad");
    }), 0);
  }
  return true;
}

function startGoogleRedirectLogin(clientId) {
  if (LOCAL_ONLY) return;
  const state = window.crypto?.randomUUID?.() || String(Date.now()) + Math.random().toString(16).slice(2);
  preferences.setItem(GOOGLE_OAUTH_STATE_KEY, state);
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: googleRedirectUri(),
    response_type: "token",
    scope: GOOGLE_DRIVE_SCOPE,
    include_granted_scopes: "true",
    prompt: "consent",
    state,
  });
  location.assign("https://accounts.google.com/o/oauth2/v2/auth?" + params);
}

async function runDriveAction(name, action) {
  if (LOCAL_ONLY) { showToast("此版本使用本机存档，未启用云端服务。"); return; }
  activeDriveAction = name || "";
  try {
    return await action();
  } finally {
    activeDriveAction = "";
  }
}

function rememberPendingDriveAction() {
  if (activeDriveAction) preferences.setItem(GOOGLE_PENDING_ACTION_KEY, activeDriveAction);
}

function takePendingDriveAction() {
  const action = preferences.getItem(GOOGLE_PENDING_ACTION_KEY) || "";
  preferences.removeItem(GOOGLE_PENDING_ACTION_KEY);
  return action;
}

function resumePendingDriveAction(action) {
  if (!action) return;
  setTimeout(() => {
    if (action === "refresh") refreshDriveList().catch(e => setDriveActivity("Refresh failed: " + googleAuthErrorMessage(e), "bad"));
    else if (action === "upload-saves") uploadSavesToDrive();
    else if (action === "restore-saves") restoreDriveSave();
    else if (action === "upload-games") uploadGamesToDrive();
    else if (action === "download-games") downloadAllDriveGames();
  }, 150);
}

function setDriveInfo(auth, cls) {
  document.body.classList.toggle("drive-connected", !!googleAccessToken);
  // Header badge
  if (driveBadgeEl) {
    if (googleAccessToken) {
      driveBadgeEl.style.display = "";
      driveBadgeEl.className = "badge drive-badge active";
      driveBadgeEl.title = "Google Drive connected — click to go to Drive tab";
      if (driveBadgeText) driveBadgeText.textContent = "Drive";
    } else {
      driveBadgeEl.style.display = "none";
      driveBadgeEl.className = "badge drive-badge";
    }
  }
  if (driveAuthEl) {
    driveAuthEl.textContent = auth || (googleAccessToken ? "Connected" : "Not connected");
    driveAuthEl.className = "info-val" + (cls ? " " + cls : (googleAccessToken ? " good" : ""));
  }
  if (driveFolderEl) {
    driveFolderEl.textContent = googleDriveRootId ? GOOGLE_DRIVE_APP_ROOT : "\u2014";
    driveFolderEl.className = "info-val" + (googleDriveRootId ? " good" : "");
  }
  if (driveRemoteEl) {
    const s = googleDriveRemoteCache.saves.length;
    const g = googleDriveRemoteCache.games.length;
    driveRemoteEl.textContent = googleAccessToken ? (s + " saves · " + g + " games") : "\u2014";
  }
}

function setDriveActivity(text, cls) {
  if (!driveActivityEl) return;
  driveActivityEl.textContent = text || "Idle";
  driveActivityEl.className = "drive-activity" + (cls ? " " + cls : "");
}

function initDriveConfigUI() {
  if (googleClientIdInput) googleClientIdInput.value = googleClientId();
  restoreGoogleToken();
  setDriveInfo();
}

function loadGoogleIdentityScript() {
  if (LOCAL_ONLY) return Promise.reject(new Error("此版本未启用云端服务"));
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const existing = document.querySelector("script[data-google-gis]");
    if (existing) {
      existing.addEventListener("load", resolve, { once: true });
      existing.addEventListener("error", () => reject(new Error("Google Identity Services failed to load")), { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = GOOGLE_GIS_SRC;
    script.async = true;
    script.defer = true;
    script.dataset.googleGis = "1";
    script.onload = resolve;
    script.onerror = () => reject(new Error("Google Identity Services failed to load"));
    document.head.appendChild(script);
  });
}

async function ensureGoogleToken(interactive) {
  if (LOCAL_ONLY) throw new Error("此版本未启用云端服务");
  const clientId = googleClientId();
  if (!clientId) throw new Error("Set a Google OAuth Web client ID first");
  if (restoreGoogleToken()) return googleAccessToken;
  if (!interactive) throw new Error("Connect Google Drive first");

  if (shouldUseRedirectOAuth()) {
    rememberPendingDriveAction();
    setDriveActivity("Continue Google login in this tab…", "run");
    startGoogleRedirectLogin(clientId);
    return new Promise(() => {});
  }

  await loadGoogleIdentityScript();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      finish(reject, new Error("Google login timed out. Browser popup may have been blocked."));
    }, GOOGLE_AUTH_TIMEOUT_MS);
    googleTokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: GOOGLE_DRIVE_SCOPE,
      callback: (response) => {
        if (response.error) {
          finish(reject, new Error(response.error_description || response.error));
          return;
        }
        setGoogleToken(response.access_token, response.expires_in);
        setDriveInfo("Connected", "good");
        finish(resolve, googleAccessToken);
      },
      error_callback: (error) => {
        const type = String(error?.type || error?.message || "");
        if (/popup_failed_to_open|popup_blocked/i.test(type)) {
          setDriveActivity("Popup blocked; switching to redirect login…", "run");
          startGoogleRedirectLogin(clientId);
          return;
        }
        finish(reject, new Error(error?.message || error?.type || "Google popup failed"));
      },
    });
    try { googleTokenClient.requestAccessToken({ prompt: "consent" }); }
    catch(e) { finish(reject, e); }
  });
}

async function ensureDriveReady(interactive) {
  await ensureDriveFolders(interactive);
  return true;
}

function disconnectGoogleDrive() {
  const token = googleAccessToken;
  setGoogleToken("", 0);
  takePendingDriveAction();
  googleDriveRootId = "";
  googleDriveSavesId = "";
  googleDriveGamesId = "";
  googleDriveRemoteCache = { saves: [], games: [] };
  if (!LOCAL_ONLY && token && window.google?.accounts?.oauth2?.revoke) {
    try { window.google.accounts.oauth2.revoke(token, () => {}); } catch(e) {}
  }
  restartDriveAutoSyncTimer(); // will stop timer since not connected
  renderDriveRemoteList();
  setDriveInfo("Not connected");
  setDriveActivity("Disconnected");
  showToast("Google Drive disconnected");
}

async function driveFetch(url, options = {}) {
  const token = await ensureGoogleToken(false);
  const headers = new Headers(options.headers || {});
  headers.set("Authorization", "Bearer " + token);
  const response = await fetch(url, { ...options, headers });
  if (response.status === 401) {
    setGoogleToken("", 0);
    throw new Error("Google session expired. Connect again.");
  }
  if (!response.ok) {
    let detail = "";
    try { detail = (await response.json()).error?.message || ""; } catch(e) {}
    throw new Error("Drive HTTP " + response.status + (detail ? ": " + detail : ""));
  }
  return response;
}

function driveQuote(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function driveList(q, fields) {
  const files = [];
  let pageToken = "";
  do {
    const params = new URLSearchParams({
      q,
      fields: "nextPageToken, files(" + fields + ")",
      pageSize: "1000",
      spaces: "drive",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const res = await driveFetch("https://www.googleapis.com/drive/v3/files?" + params);
    const json = await res.json();
    files.push(...(json.files || []));
    pageToken = json.nextPageToken || "";
  } while (pageToken);
  return files;
}

async function driveFindFile(name, parentId, mimeType) {
  let q = "name = '" + driveQuote(name) + "' and trashed = false";
  if (parentId) q += " and '" + driveQuote(parentId) + "' in parents";
  if (mimeType) q += " and mimeType = '" + driveQuote(mimeType) + "'";
  const files = await driveList(q, "id,name,mimeType,size,modifiedTime");
  return files.sort((a, b) => String(b.modifiedTime || "").localeCompare(String(a.modifiedTime || "")))[0] || null;
}

async function driveEnsureFolder(name, parentId) {
  const folderMime = "application/vnd.google-apps.folder";
  const existing = await driveFindFile(name, parentId, folderMime);
  if (existing) return existing.id;

  const metadata = { name, mimeType: folderMime };
  if (parentId) metadata.parents = [parentId];
  const res = await driveFetch("https://www.googleapis.com/drive/v3/files?fields=id,name", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(metadata),
  });
  return (await res.json()).id;
}

async function ensureDriveFolders(interactive = false) {
  await ensureGoogleToken(interactive);
  if (!googleDriveRootId) googleDriveRootId = await driveEnsureFolder(GOOGLE_DRIVE_APP_ROOT);
  if (!googleDriveSavesId) googleDriveSavesId = await driveEnsureFolder("saves", googleDriveRootId);
  if (!googleDriveGamesId) googleDriveGamesId = await driveEnsureFolder("games", googleDriveRootId);
  setDriveInfo("Connected", "good");
}

async function uploadBlobToDrive(name, parentId, data, mimeType, progressLabel) {
  const existing = await driveFindFile(name, parentId);
  const method = existing ? "PATCH" : "POST";
  const url = existing
    ? "https://www.googleapis.com/upload/drive/v3/files/" + encodeURIComponent(existing.id) + "?uploadType=resumable&fields=id,name,size,modifiedTime"
    : "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,size,modifiedTime";
  const metadata = { name, mimeType };
  if (!existing) metadata.parents = [parentId];
  const init = await driveFetch(url, {
    method,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": mimeType,
    },
    body: JSON.stringify(metadata),
  });
  const uploadUrl = init.headers.get("Location");
  if (!uploadUrl) throw new Error("Drive did not return an upload session");

  const blob = data instanceof Blob ? data : new Blob([data], { type: mimeType });
  const token = await ensureGoogleToken(false);
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", uploadUrl);
    xhr.setRequestHeader("Authorization", "Bearer " + token);
    xhr.setRequestHeader("Content-Type", mimeType);
    xhr.upload.onprogress = (ev) => {
      if (!ev.lengthComputable) return;
      const pct = ev.loaded / ev.total;
      showLoading((progressLabel || "Uploading " + name) + "… " + Math.round(pct * 100) + "%", pct);
      setStatus("Drive upload: " + name + " (" + formatBytes(ev.loaded) + " / " + formatBytes(ev.total) + ")", "run");
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        setStatus("Drive upload: " + name + " – done", "ok");
        try { resolve(JSON.parse(xhr.responseText || "{}")); }
        catch(e) { resolve({ name }); }
      } else {
        setStatus("Drive upload failed: HTTP " + xhr.status, "err");
        reject(new Error("Drive upload failed: HTTP " + xhr.status));
      }
    };
    xhr.onerror = () => reject(new Error("Drive upload network error"));
    xhr.send(blob);
  });
}

async function refreshDriveList() {
  setDriveActivity("Reading Drive folders…", "run");
  await ensureDriveReady(true);
  const fields = "id,name,mimeType,size,modifiedTime";
  googleDriveRemoteCache.saves = await driveList("'" + driveQuote(googleDriveSavesId) + "' in parents and trashed = false", fields);
  googleDriveRemoteCache.games = await driveList("'" + driveQuote(googleDriveGamesId) + "' in parents and trashed = false", fields);
  googleDriveRemoteCache.saves.sort((a, b) => String(b.modifiedTime || "").localeCompare(String(a.modifiedTime || "")));
  googleDriveRemoteCache.games.sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
  renderDriveRemoteList();
  setDriveInfo("Connected", "good");
  setDriveActivity("Drive ready: " + googleDriveRemoteCache.saves.length + " save bundle(s), " + googleDriveRemoteCache.games.length + " game file(s)", "ok");
  updateDriveAutoSyncUI();
}

function renderDriveRemoteList() {
  if (!driveRemoteList) return;
  const saves = googleDriveRemoteCache.saves || [];
  const games = googleDriveRemoteCache.games || [];
  if (!googleAccessToken) {
    driveRemoteList.innerHTML = `<span class="drive-empty">Connect Google Drive to list remote saves and games.</span>`;
    return;
  }
  if (!saves.length && !games.length) {
    driveRemoteList.innerHTML = `<span class="drive-empty">No Drive files yet. Upload saves or your game library.</span>`;
    return;
  }
  let html = "";
  if (saves.length) {
    html += `<div class="drive-section-label"><span>Saves</span><span>${saves.length}</span></div>`;
    for (const file of saves) {
      html += `<div class="drive-file-row">
        <div class="drive-file-name" title="${esc(file.name)}">${esc(file.name)}</div>
        <div class="drive-file-size">${formatBytes(Number(file.size || 0))}</div>
        <button title="Restore" data-drive-action="restore-save" data-id="${esc(file.id)}">${svgIcon("upload")}</button>
      </div>`;
    }
  }
  if (games.length) {
    html += `<div class="drive-section-label"><span>Games</span><span>${games.length}</span></div>`;
    for (const file of games) {
      html += `<div class="drive-file-row">
        <div class="drive-file-name" title="${esc(file.name)}">${esc(file.name)}</div>
        <div class="drive-file-size">${formatBytes(Number(file.size || 0))}</div>
        <button title="Download to OPFS" data-drive-action="download-game" data-id="${esc(file.id)}">${svgIcon("download")}</button>
      </div>`;
    }
  }
  driveRemoteList.innerHTML = html;
}

async function driveDownloadBytes(file, label) {
  const res = await driveFetch("https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(file.id) + "?alt=media");
  return readResponseBytes(res, label || file.name);
}

async function connectGoogleDrive() {
  try {
    setDriveActivity("Opening Google login…", "run");
    await ensureGoogleToken(true);
    showToast("Google Drive connected");
    restartDriveAutoSyncTimer();
    await refreshDriveList();
  } catch(e) {
    const message = googleAuthErrorMessage(e);
    log("Google Drive connect failed: " + message, "err");
    setDriveInfo("Connect failed", "bad");
    setDriveActivity("Connect failed: " + message, "bad");
    showToast("操作未完成：" + message, 5000);
  } finally {
    hideLoading();
  }
}

async function uploadSavesToDrive() {
  try {
    setDriveActivity("Preparing save bundle…", "run");
    if (window.FS) await persistFiles(window.FS, "drive");
    await ensureDriveFolders(true);
    const bundle = await buildSavesBundle();
    if (!bundle) {
      setDriveActivity("No save data found to upload", "warn");
      showToast("No save data to upload.");
      return;
    }
    const bytes = new TextEncoder().encode(JSON.stringify(bundle));
    setDriveActivity("Uploading saves bundle (" + formatBytes(bytes.byteLength) + ")…", "run");
    showLoading("Uploading saves to Drive…");
    await uploadBlobToDrive(GOOGLE_DRIVE_SAVE_BUNDLE, googleDriveSavesId, bytes, "application/json", "Uploading saves");
    log("Google Drive: uploaded saves bundle with " + bundle.files.length + " files.", "ok");
    setDriveActivity("Uploaded saves bundle with " + bundle.files.length + " file(s)", "ok");
    showToast("✓ Saves uploaded to Drive");
    await refreshDriveList();
  } catch(e) {
    const message = googleAuthErrorMessage(e);
    log("Google Drive save upload failed: " + message, "err");
    setDriveActivity("Save upload failed: " + message, "bad");
    showToast("操作未完成：" + message, 5000);
  } finally {
    hideLoading();
  }
}

async function restoreDriveSave(file) {
  try {
    setDriveActivity("Preparing save restore…", "run");
    await ensureDriveFolders(true);
    if (!file && !googleDriveRemoteCache.saves.length) await refreshDriveList();
    const target = file || googleDriveRemoteCache.saves[0];
    if (!target) {
      setDriveActivity("No Drive save bundle found", "warn");
      showToast("No Drive save bundle found");
      return;
    }
    showLoading("Downloading saves from Drive…");
    setDriveActivity("Downloading " + target.name + "…", "run");
    const bytes = await driveDownloadBytes(target, target.name);
    const bundle = JSON.parse(new TextDecoder().decode(bytes));
    await importSavesBundle(bundle, "Google Drive " + target.name);
    log("Google Drive: restored saves from " + target.name + ".", "ok");
    setDriveActivity("Restored saves from " + target.name, "ok");
    setStatus("Restored saves from Drive", "ok");
    showToast("✓ Restored saves from Drive");
  } catch(e) {
    const message = googleAuthErrorMessage(e);
    log("Google Drive save restore failed: " + message, "err");
    setDriveActivity("Save restore failed: " + message, "bad");
    showToast("操作未完成：" + message, 5000);
  } finally {
    hideLoading();
  }
}

async function uploadGamesToDrive() {
  try {
    setDriveActivity("Scanning local game library…", "run");
    await ensureDriveFolders(true);
    const games = await opfsWalk(OPFS_GAMES_DIR, "", false);
    if (!games.length) {
      setDriveActivity("No local games in OPFS to upload", "warn");
      showToast("No local games in OPFS to upload");
      return;
    }
    let done = 0;
    for (const game of games) {
      setDriveActivity("Uploading game " + (done + 1) + "/" + games.length + ": " + game.path, "run");
      const bytes = await opfsReadGame(game.path);
      await uploadBlobToDrive(game.path, googleDriveGamesId, bytes, "application/octet-stream",
        "Uploading game " + (done + 1) + "/" + games.length);
      done++;
      log("Google Drive: uploaded game " + game.path + " (" + formatBytes(bytes.byteLength) + ").", "ok");
    }
    setDriveActivity("Uploaded " + done + " game" + (done === 1 ? "" : "s") + " to Drive", "ok");
    showToast("✓ Uploaded " + done + " game" + (done === 1 ? "" : "s") + " to Drive");
    await refreshDriveList();
  } catch(e) {
    const message = googleAuthErrorMessage(e);
    log("Google Drive game upload failed: " + message, "err");
    setDriveActivity("Game upload failed: " + message, "bad");
    showToast("操作未完成：" + message, 5000);
  } finally {
    hideLoading();
  }
}

async function downloadDriveGame(file) {
  try {
    setDriveActivity("Preparing game download…", "run");
    await ensureDriveFolders(true);
    showLoading("Downloading " + file.name + " from Drive…");
    setDriveActivity("Downloading " + file.name + "…", "run");
    const response = await driveFetch("https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(file.id) + "?alt=media");
    const stored = await storeGameResponse(file.name, response);
    const storedName = stored.name;
    log("Google Drive: downloaded game " + storedName + " (" + formatBytes(stored.size) + ").", "ok");
    setDriveActivity("Downloaded " + storedName + " to OPFS", "ok");
    setStatus("Downloaded " + storedName + " to OPFS", "ok");
    showToast("✓ 已导出 " + storedName);
    await refreshLibrary();
    updateStorageInfo();
  } catch(e) {
    const message = googleAuthErrorMessage(e);
    log("Google Drive game download failed: " + message, "err");
    setDriveActivity("Game download failed: " + message, "bad");
    showToast("操作未完成：" + message, 5000);
  } finally {
    hideLoading();
  }
}

async function downloadAllDriveGames() {
  try {
    setDriveActivity("Preparing remote game downloads…", "run");
    await ensureDriveFolders(true);
    if (!googleDriveRemoteCache.games.length) await refreshDriveList();
    const games = googleDriveRemoteCache.games;
    if (!games.length) {
      setDriveActivity("No remote games found", "warn");
      showToast("No remote games found");
      return;
    }
    for (const game of games) await downloadDriveGame(game);
    setDriveActivity("Downloaded " + games.length + " remote game" + (games.length === 1 ? "" : "s"), "ok");
    showToast("✓ 已导出 " + games.length + " remote game" + (games.length === 1 ? "" : "s"));
  } catch(e) {
    const message = googleAuthErrorMessage(e);
    log("Google Drive bulk game download failed: " + message, "err");
    setDriveActivity("Bulk game download failed: " + message, "bad");
    showToast("操作未完成：" + message, 5000);
  } finally {
    hideLoading();
  }
}

/* ── Runtime game loading (while PPSSPP is running) ─────────────── */
async function loadGameAtRuntime(file) {
  if (!validateGameSelection(file)) return;
  const FS = window.FS;
  if (!FS) { showToast("请先启动模拟器。"); return; }
  const safe = file.name.replace(/[^a-zA-Z0-9._\-]/g, "_");
  const path = VIRTUAL_GAME_DIR + "/" + safe;
  log("Loading game at runtime: " + file.name + " → " + path, "info");
  showToast("正在载入 " + file.name + "…");
  try {
    mountBrowserGame(FS, file, safe);
    refreshEmulatorGameBrowser("mounted " + safe);
    log("Game file registered for this session: " + path, "ok");
    showToast("✓ " + file.name + " 仅本次载入，请从模拟器游戏列表中打开；需要缓存时请先退出游玩再添加到游戏库。", 6500);
    refreshLibrary();
    updateStorageInfo();
  } catch(e) { log("Runtime game load failed: " + e.message, "err"); showToast("操作未完成：" + e.message); }
}

/* ── AudioWorklet player ────────────────────────────────────────── */
let audioWorkletPlayer     = null;
let audioWorkletIniting    = false;
let scriptFallbackPlayer   = null;
let useScriptFallbackAudio = true;
let gameAudioGain          = 1.0;

const WORKLET_CODE = `
class PPSSPPAudio extends AudioWorkletProcessor {
  constructor(o) {
super(o);
const s = o.processorOptions.sab;
this.wi   = new Int32Array(s, 0, 1);
this.ri   = new Int32Array(s, 4, 1);
this.cap  = o.processorOptions.cap;
this.data = new Float32Array(s, 8, this.cap * 2);
this.tick = 0; this.total = 0;
  }
  process(_, outputs) {
const ch = outputs[0];
if (!ch || !ch[0]) return true;
const n = ch[0].length;
let r = Atomics.load(this.ri, 0);
const w = Atomics.load(this.wi, 0);
const avail = (w - r + this.cap) % this.cap;
const read  = Math.min(n, avail);
let peak = 0;
for (let i = 0; i < read; i++) {
  const idx = r * 2;
  const l = this.data[idx], rr = this.data[idx + 1];
  ch[0][i] = l; if (ch[1]) ch[1][i] = rr;
  peak = Math.max(peak, Math.abs(l), Math.abs(rr));
  r = (r + 1) % this.cap;
}
for (let i = read; i < n; i++) { ch[0][i] = 0; if (ch[1]) ch[1][i] = 0; }
Atomics.store(this.ri, 0, r);
this.total += read; this.tick++;
if (this.tick === 1 || this.tick % 344 === 0)
  this.port.postMessage({ type:'status', tick:this.tick, avail, read, total:this.total, peak });
return true;
  }
}
registerProcessor('ppsspp-audio', PPSSPPAudio);
`;

async function initAudioWorkletPlayer(ctx) {
  if (audioWorkletPlayer || audioWorkletIniting || !ctx) return;
  if (!window.crossOriginIsolated) {
    log("AUDIO: SharedArrayBuffer unavailable (crossOriginIsolated=false). Check COOP/COEP server headers.", "warn");
    return;
  }
  audioWorkletIniting = true;
  try {
    const blob = new Blob([WORKLET_CODE], { type: "application/javascript" });
    const burl = URL.createObjectURL(blob);
    await ctx.audioWorklet.addModule(burl);
    URL.revokeObjectURL(burl);
    const cap = 16384;
    const sab = new SharedArrayBuffer(8 + cap * 2 * 4);
    const node = new AudioWorkletNode(ctx, "ppsspp-audio", {
      numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
      processorOptions: { sab, cap },
    });
    const gain = ctx.createGain();
    gain.gain.value = 1.0;
    if (!useScriptFallbackAudio) { node.connect(gain); gain.connect(ctx.destination); }
    node.port.onmessage = (ev) => {
      if (ev.data?.type === "status") {
        const d = ev.data;
        audioDebug.workletPeak  = d.peak  || 0;
        audioDebug.workletTotal = d.total || audioDebug.workletTotal;
        if (d.tick <= 3 || d.tick % 344 === 0)
          log(`Worklet tick=${d.tick}: avail=${d.avail} read=${d.read} peak=${(d.peak||0).toFixed(4)} consumed=${d.total}`);
      }
    };
    node.onprocessorerror = (e) => log("AUDIO: AudioWorklet processor error: " + (e?.message || e), "err");
    audioWorkletPlayer = {
      node, gain,
      wi: new Int32Array(sab, 0, 1), ri: new Int32Array(sab, 4, 1),
      data: new Float32Array(sab, 8, cap * 2), cap,
    };
    log("AUDIO: AudioWorklet ready (sampleRate=" + ctx.sampleRate + ", buffer=" + cap + " frames).", "ok");
  } catch (e) {
    log("AUDIO: AudioWorklet init failed: " + (e?.message || e), "err");
  } finally { audioWorkletIniting = false; }
}

function initScriptFallbackPlayer(ctx) {
  if (scriptFallbackPlayer || !ctx) return;
  try {
    const cap = 32768;
    const data = new Float32Array(cap * 2);
    const processor = ctx.createScriptProcessor(2048, 0, 2);
    const gain = ctx.createGain();
    let r = 0, w = 0, total = 0, tick = 0;
    processor.onaudioprocess = (event) => {
      const left  = event.outputBuffer.getChannelData(0);
      const right = event.outputBuffer.getChannelData(1);
      const n = left.length;
      const avail = (w - r + cap) % cap;
      const read  = Math.min(n, avail);
      let peak = 0;
      for (let i = 0; i < read; i++) {
        const idx = r * 2;
        left[i] = data[idx]; right[i] = data[idx + 1];
        peak = Math.max(peak, Math.abs(data[idx]), Math.abs(data[idx + 1]));
        r = (r + 1) % cap;
      }
      for (let i = read; i < n; i++) { left[i] = 0; right[i] = 0; }
      total += read; audioDebug.fallbackPeak = peak; tick++;
      if (tick === 1 || tick % 22 === 0)
        log("ScriptProcessor tick=" + tick + ": avail=" + avail + " read=" + read + " peak=" + peak.toFixed(4) + " consumed=" + total);
    };
    gain.gain.value = gameAudioGain;
    processor.connect(gain); gain.connect(ctx.destination);
    scriptFallbackPlayer = {
      data, cap, processor, gain,
      push(samples, frames) {
        const push = Math.min(frames, cap - 1);
        const used = (w - r + cap) % cap;
        const free = cap - 1 - used;
        if (push > free) {
          const drop = push - free; r = (r + drop) % cap;
          audioDebug.fallbackDropped += drop;
        }
        for (let i = 0; i < push; i++) {
          data[w * 2]     = Math.max(-1, Math.min(1, samples[i * 2]     || 0));
          data[w * 2 + 1] = Math.max(-1, Math.min(1, samples[i * 2 + 1] || 0));
          w = (w + 1) % cap;
        }
      }
    };
    log("AUDIO: ScriptProcessor fallback ready (buffer=" + cap + " frames, gain=" + gameAudioGain + ").", "ok");
  } catch (e) { log("AUDIO: ScriptProcessor fallback init failed: " + (e?.message || e), "err"); }
}

/* Called from SDL C callback via EM_ASM – must be fast */
function pushGameAudioSamples(samples, frames) {
  scriptFallbackPlayer?.push(samples, frames);
  if (useScriptFallbackAudio) return;
  const p = audioWorkletPlayer;
  if (!p || !samples || frames <= 0) return;
  let w = Atomics.load(p.wi, 0);
  let r = Atomics.load(p.ri, 0);
  const used = (w - r + p.cap) % p.cap;
  let free = p.cap - 1 - used;
  const push = Math.min(frames, p.cap - 1);
  if (push > free) {
    const drop = push - free; r = (r + drop) % p.cap;
    Atomics.store(p.ri, 0, r); audioDebug.ringDropped += drop; free += drop;
  }
  for (let i = 0; i < push; i++) {
    p.data[w * 2]     = Math.max(-1, Math.min(1, samples[i * 2]     || 0));
    p.data[w * 2 + 1] = Math.max(-1, Math.min(1, samples[i * 2 + 1] || 0));
    w = (w + 1) % p.cap;
  }
  Atomics.store(p.wi, 0, w);
}

/* ── Log system ─────────────────────────────────────────────────── */
const MAX_LOG_LINES = 500;
let logLines = [], pendingLines = [], logRafId = 0, filterText = "";

function classifyLine(text) {
  const t = text.toLowerCase();
  if (/error|abort|failed|fail|crash/.test(t)) return "err";
  if (/warn/.test(t))                          return "warn";
  if (/\b(ok|ready|loaded|initialized|done)\b/.test(t)) return "ok";
  if (/audio|gpu|webgl|shader/.test(t))        return "info";
  if (/stdout:|stderr:/.test(t))               return "dim";
  return "";
}

function esc(s) { return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;"); }

function buildLineHtml(rawLine, forceLevel) {
  const m   = rawLine.match(/^(\[\d{1,2}:\d{2}:\d{2}\]) (.*)$/s);
  const ts  = m ? esc(m[1]) : "";
  const txt = esc(m ? m[2] : rawLine);
  const cls = forceLevel || classifyLine(rawLine);
  const inner = cls
    ? '<span class="l-ts">' + ts + '</span> <span class="l-' + cls + '">' + txt + '</span>'
    : '<span class="l-ts">' + ts + '</span> ' + txt;
  return { raw: rawLine, html: inner };
}

function flushLog() {
  logRafId = 0;
  if (!pendingLines.length) return;
  for (const e of pendingLines) logLines.push(e);
  pendingLines = [];
  if (logLines.length > MAX_LOG_LINES) logLines.splice(0, logLines.length - MAX_LOG_LINES);
  if (document.body.classList.contains("panel-open") && byId("tabLog")?.classList.contains("active")) renderLog();
}

function renderLog() {
  if (!logEl) return;
  const ft = filterText.toLowerCase();
  const vis = ft ? logLines.filter(e => e.raw.toLowerCase().includes(ft)) : logLines;
  logEl.innerHTML = vis.map(e => e.html).join("\n") + "\n";
  logEl.scrollTop = logEl.scrollHeight;
}

on(logFilter, "input", () => { filterText = logFilter.value.trim(); renderLog(); });
on("clearLogBtn", "click", () => { logLines = []; pendingLines = []; if (logEl) logEl.innerHTML = ""; });

function log(text, level) {
  if (/\bBooted \/browser-games\//.test(text)) globalThis.PpssppPerformance?.mark("gameBooted");
  const ts  = new Date().toLocaleTimeString("en-GB", { hour12: false });
  const raw = "[" + ts + "] " + text;
  pendingLines.push(buildLineHtml(raw, level || ""));
  if (pendingLines.length > MAX_LOG_LINES) pendingLines.splice(0, pendingLines.length - MAX_LOG_LINES);
  // DevTools console retention is expensive during sustained core logging.
  if (level === "err" || preferences.getItem("ppsspp_verbose_console") === "1") console.log(raw);
  updateAudioDebugFromLog(text);
  if (!logRafId) logRafId = requestAnimationFrame(flushLog);
}

/* ── Status ─────────────────────────────────────────────────────── */
function setStatus(text, kind) {
  if (statusEl) statusEl.textContent = text;
  if (statusDot) statusDot.className = "status-dot" + (kind ? " " + kind : "");
  // also update the always-visible stage overlay
  if (stageMiniTextEl) stageMiniTextEl.textContent = text;
  if (stageDotEl) stageDotEl.className = "stage-dot" + (kind ? " " + kind : "");
  log((kind === "err" ? "ERROR: " : "") + text, kind === "err" ? "err" : undefined);
}

function showLoading(label, progress) {
  loadOverlay?.classList.add("visible");
  if (loadLabel) loadLabel.textContent = label;
  if (progressBar) progressBar.style.width = (progress != null && progress >= 0) ? (progress * 100).toFixed(1) + "%" : "0%";
}
function hideLoading() {
  loadOverlay?.classList.remove("visible");
  if (progressBar) progressBar.style.width = "0%";
  if (loadLabel) loadLabel.textContent = "";
}

/* ── System info panel ──────────────────────────────────────────── */
function setInfoVal(id, val, cls) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent  = val;
  el.className    = "info-val" + (cls ? " " + cls : "");
}

function updateInfoPanel() {
  const sdlCtx = window.Module?.SDL2?.audioContext || trackedAudioContexts[trackedAudioContexts.length - 1];
  setInfoVal("iACtx",  sdlCtx ? sdlCtx.state : "none", sdlCtx?.state === "running" ? "good" : "warn");
  setInfoVal("iASR",   sdlCtx ? sdlCtx.sampleRate + " Hz" : "\u2014");
  setInfoVal("iACB",   String(audioDebug.callbacks));
  setInfoVal("iAPeak", audioDebug.peak ? String(audioDebug.peak) : "0");
  setInfoVal("iCOI",   String(window.crossOriginIsolated), window.crossOriginIsolated ? "good" : "bad");
  setInfoVal("iSAB",   typeof SharedArrayBuffer !== "undefined" ? "yes" : "no",
                       typeof SharedArrayBuffer !== "undefined" ? "good" : "bad");
  setInfoVal("iHWC",   String(navigator.hardwareConcurrency || "?"));
}

/* ── Audio helpers ──────────────────────────────────────────────── */
function updateAudioDebugFromLog(text) {
  if (text.includes("SDL audio device started")) audioDebug.deviceStarted = true;
  const m  = text.match(/WASM audio callback count=(\d+) nonsilent=(\d+) frames=(\d+) peak=(\d+) rate=(\d+)/);
  if (m) { audioDebug.callbacks = +m[1]; audioDebug.nonsilent = +m[2]; audioDebug.peak = +m[4]; audioDebug.rate = +m[5]; }
  const m2 = text.match(/WASM audio push count=(\d+) nonsilent=(\d+) frames=(\d+) peak=(\d+)/);
  if (m2) { audioDebug.pushes = +m2[1]; audioDebug.pushNonsilent = +m2[2]; audioDebug.pushPeak = +m2[4]; audioDebug.peak = Math.max(audioDebug.peak, +m2[4]); }
}

async function reportAudioStatus() {
  if (!started) return;
  const SDL2 = window.Module?.SDL2 || window.SDL2;
  const all  = [...trackedAudioContexts];
  if (SDL2?.audioContext && !all.includes(SDL2.audioContext)) all.push(SDL2.audioContext);
  for (const ctx of all)
    if (ctx?.state === "suspended") try { await ctx.resume(); log("AudioContext auto-resumed: state=" + ctx.state); } catch(e) {}
  const sdlCtx = window.Module?.SDL2?.audioContext;
  const state  = sdlCtx ? sdlCtx.state : "none";
  if (audioDebug.callbacks === 0)
    log("AUDIO: SDL callbacks=0, ctx=" + state + ". Waiting for game start or click Audio.");
  else
    log("AUDIO: callbacks=" + audioDebug.callbacks + " (nonsilent=" + audioDebug.nonsilent + "), peak=" + audioDebug.peak + ", underruns=" + audioDebug.underruns + ", dropped=" + audioDebug.ringDropped + ", ctx=" + state + ".");
  updateInfoPanel();
}

function installAudioContextTracking() {
  for (const name of ["AudioContext", "webkitAudioContext"]) {
    const Orig = window[name];
    if (!Orig || Orig.__ppssppTracked) continue;
    function Tracked(...args) {
      const ctx = new Orig(...args);
      trackedAudioContexts.push(ctx);
      log(name + " created: state=" + ctx.state + ", sampleRate=" + ctx.sampleRate);
      ctx.addEventListener?.("statechange", () => log(name + " state -> " + ctx.state));
      return ctx;
    }
    Tracked.prototype = Orig.prototype;
    Object.setPrototypeOf(Tracked, Orig);
    Tracked.__ppssppTracked = true;
    window[name] = Tracked;
  }
}

function describeAudio() {
  const SDL2 = window.Module?.SDL2 || window.SDL2;
  const ctx  = SDL2?.audioContext || trackedAudioContexts[trackedAudioContexts.length - 1];
  if (!ctx) { log("Audio: no AudioContext created."); return; }
  log("Audio: state=" + ctx.state + ", sampleRate=" + ctx.sampleRate + ", contexts=" + trackedAudioContexts.length);
}

async function createOrResumeAudioContext() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { log("WebAudio not available in this browser.", "warn"); return null; }
    let ctx = window.Module?.SDL2?.audioContext || trackedAudioContexts[trackedAudioContexts.length - 1];
    if (!ctx || ctx.state === "closed") ctx = new AC();
    if (ctx.state === "suspended") await ctx.resume();
    log("AudioContext ready: state=" + ctx.state + ", sampleRate=" + ctx.sampleRate, "ok");
    return ctx;
  } catch(e) { log("AudioContext creation failed: " + (e?.message || e), "err"); return null; }
}

async function unlockAudio() {
  // Collect ALL known contexts: SDL's + any tracked
  const sdlCtx = (window.Module?.SDL2 || window.SDL2)?.audioContext;
  const all = [...trackedAudioContexts];
  if (sdlCtx && !all.includes(sdlCtx)) all.push(sdlCtx);
  for (const ctx of all) {
    if (!ctx || ctx.state === 'closed') continue;
    if (ctx.state === 'suspended' || ctx.state === 'interrupted') {
      try { await ctx.resume(); } catch(e) {}
    }
  }
}

function playWebAudioTone(ctx) {
  const osc = ctx.createOscillator(), gain = ctx.createGain();
  osc.type = "square"; osc.frequency.value = 880;
  gain.gain.setValueAtTime(0.2, ctx.currentTime);
  gain.gain.setValueAtTime(0.2, ctx.currentTime + 0.45);
  gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.5);
  osc.connect(gain); gain.connect(ctx.destination);
  osc.start(); osc.stop(ctx.currentTime + 0.5);
  log("WebAudio beep sent: state=" + ctx.state + ", t=" + ctx.currentTime.toFixed(3));
}

function playHtmlAudioTone() {
  const sr = 44100, dur = 0.5, n = Math.floor(sr * dur);
  const buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const ws  = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  ws(0,"RIFF"); v.setUint32(4,36+n*2,true); ws(8,"WAVE"); ws(12,"fmt ");
  v.setUint32(16,16,true); v.setUint16(20,1,true); v.setUint16(22,1,true);
  v.setUint32(24,sr,true); v.setUint32(28,sr*2,true);
  v.setUint16(32,2,true);  v.setUint16(34,16,true);
  ws(36,"data"); v.setUint32(40,n*2,true);
  for (let i = 0; i < n; i++) {
    const env  = Math.min(1,i/600)*Math.min(1,(n-i)/1200);
    v.setInt16(44+i*2, Math.round(Math.sin(2*Math.PI*660*i/sr)*0.35*env*32767), true);
  }
  const url = URL.createObjectURL(new Blob([buf],{type:"audio/wav"}));
  const a   = new Audio(url);
  a.volume  = 1.0;
  a.addEventListener("ended", () => URL.revokeObjectURL(url), {once:true});
  a.play().then(()=>log("HTML Audio beep sent.")).catch(e=>log("HTML Audio beep blocked: "+(e?.message||e),"warn"));
}

installAudioContextTracking();

/* ── ScriptProcessor → AudioWorklet polyfill (Chrome 126+ compat) ── */
/* Chrome removed createScriptProcessor; SDL's WASM backend uses it.  */
/* Replacement: AudioWorklet with a hardware-clock playhead.          */
/* It prebuffers a small lookahead, but only generates audio up to    */
/* ctx.currentTime + lookahead so timer jitter cannot make it run hot.*/
const SP_SHIM_WORKLET = `
class PPSSPPSpShim extends AudioWorkletProcessor {
  constructor(opts) {
super(opts);
const p        = opts.processorOptions || {};
this._nCh      = p.channels || 2;
this._cap      = p.cap      || 65536;
this._ctrl     = new Int32Array(p.sab, 0, 8);
this._data     = new Float32Array(p.sab, 32, this._cap * this._nCh);
this._last     = new Float32Array(this._nCh);
this._ramp     = 0;
this._rampFrames = 128;
this._tick     = 0;
  }
  process(inputs, outputs) {
const ch = outputs[0];
if (!ch || !ch[0]) return true;
const n = ch[0].length;
let r = Atomics.load(this._ctrl, 1);
const w = Atomics.load(this._ctrl, 0);
const avail = (w - r + this._cap) % this._cap;
const read  = Math.min(n, avail);
let ramp = this._ramp;
for (let i = 0; i < read; i++) {
  const blend = ramp > 0 ? 1.0 - ramp / this._rampFrames : 1.0;
  for (let c = 0; c < ch.length; c++) {
    const src = this._data[r * this._nCh + Math.min(c, this._nCh - 1)];
    const out = ramp > 0 ? this._last[c] * (1.0 - blend) + src * blend : src;
    ch[c][i] = out;
    this._last[c] = out;
  }
  if (ramp > 0) ramp--;
  r = (r + 1) % this._cap;
}
this._ramp = ramp;
if (read < n) {
  Atomics.add(this._ctrl, 4, 1);
  this._ramp = this._rampFrames;
  for (let i = read; i < n; i++) {
    for (let c = 0; c < ch.length; c++) {
      this._last[c] *= 0.985;
      ch[c][i] = Math.abs(this._last[c]) < 0.00001 ? 0 : this._last[c];
    }
  }
}
Atomics.store(this._ctrl, 1, r);
Atomics.add(this._ctrl, 2, read);
// Report consumed count periodically so main thread can track ring fill.
if ((++this._tick & 15) === 0)
  this.port.postMessage({ type: 'status', avail, underruns: Atomics.load(this._ctrl, 4) });
return true;
  }
}
registerProcessor('ppsspp-sp-shim', PPSSPPSpShim);
`;

const _spModuleCtxSet  = new WeakSet();
const _spModulePending = new WeakMap(); // ctx → Promise

async function ensureSpShimModule(ctx) {
  if (_spModuleCtxSet.has(ctx)) return true;
  if (_spModulePending.has(ctx)) return _spModulePending.get(ctx);
  const p = (async () => {
    try {
      const blob = new Blob([SP_SHIM_WORKLET], { type: 'application/javascript' });
      const url  = URL.createObjectURL(blob);
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      _spModuleCtxSet.add(ctx);
      log('AUDIO: SP→Worklet shim module loaded.', 'ok');
      return true;
    } catch(e) {
      log('AUDIO: SP shim module failed: ' + (e?.message || e), 'warn');
      return false;
    }
  })();
  _spModulePending.set(ctx, p);
  return p;
}

/* ── makeScriptProcessorShim ──────────────────────────────────────
 * Replaces ScriptProcessorNode with an AudioWorkletNode.
 * The pump is locked to a produced-audio playhead:
 *   - It may prebuffer a small lookahead.
 *   - It never generates past the hardware playhead + lookahead.
 *   - Timer bursts can top up the buffer, but cannot advance audio time.
 * ────────────────────────────────────────────────────────────────*/
function makeScriptProcessorShim(ctx, bufferSize, nIn, nOut) {
  const nCh          = Math.max(1, nOut || 2);
  const bufsz        = bufferSize || 2048;
  const SR           = ctx.sampleRate || 44100;
  const RING_CAP     = 32768;          // ring capacity in frames
  const LOOKAHEAD    = Math.max(SR * 0.070, bufsz * 2);
  const MAX_FILL     = Math.max(SR * 0.180, bufsz * 5);
  const MAX_BURST    = 16;             // max pushes per pump call

  let _handler = null;
  let _wn      = null;
  let _gain    = null;
  let _dest    = null;
  let _timerId = null;
  let _fakeBuf = null;
  let _fakeChannels = [];
  let _ctrl    = null;
  let _data    = null;

  // Clock-sync state (all in frames)
  let _playheadStartTime = 0;
  let _producedFrames = 0;
  let _workletDropped = 0;
  let _lastUnderruns = 0;
  let _adaptiveExtra = 0;
  let _lastUnderrunTime = 0;
  let _pushCount = 0;

  try {
    _fakeBuf = ctx.createBuffer(nCh, bufsz, SR);
    _fakeChannels = Array.from({ length: nCh }, (_, c) => _fakeBuf.getChannelData(c));
  } catch(e) {}

  /* Push ONE SDL callback's worth of audio to the worklet ring */
  function pushOne() {
    if (!_handler || !_fakeBuf || !_wn || !_ctrl || !_data) return false;
    let w = Atomics.load(_ctrl, 0);
    let r = Atomics.load(_ctrl, 1);
    const used = (w - r + RING_CAP) % RING_CAP;
    const free = RING_CAP - 1 - used;
    if (bufsz > free) {
      return false;
    }
    try { _handler({ outputBuffer: _fakeBuf }); } catch(e) { return false; }
    const measurePeak = (_pushCount++ & 15) === 0;
    let peak = 0;
    for (let i = 0; i < bufsz; i++) {
      for (let c = 0; c < nCh; c++) {
        const sample = _fakeChannels[c][i];
        _data[w * nCh + c] = sample;
        if (measurePeak) peak = Math.max(peak, Math.abs(sample));
      }
      w = (w + 1) % RING_CAP;
    }
    audioDebug.callbacks++;
    audioDebug.rate = SR;
    if (measurePeak) {
      audioDebug.peak = Math.round(peak * 32767);
      if (peak > 0) audioDebug.nonsilent++;
    }
    Atomics.store(_ctrl, 0, w);
    _producedFrames += bufsz;
    return true;
  }

  function resetPlayhead(now) {
    _playheadStartTime = now || ctx.currentTime || 0;
    _producedFrames = 0;
  }

  /* Clock-locked pump: safe to call as often as desired. */
  function pump() {
    if (ctx.state !== 'running' || !_handler || !_wn) return;
    if (!_playheadStartTime) resetPlayhead(ctx.currentTime);

    _workletDropped = Atomics.load(_ctrl, 3);
    const underruns = Atomics.load(_ctrl, 4);
    if (underruns !== _lastUnderruns) {
      _lastUnderruns = underruns;
      _lastUnderrunTime = ctx.currentTime;
      _adaptiveExtra = Math.min(SR * 0.120, _adaptiveExtra + bufsz);
      audioDebug.underruns = underruns;
    } else if (_adaptiveExtra > 0 && ctx.currentTime - _lastUnderrunTime > 3.0) {
      _adaptiveExtra = Math.max(0, _adaptiveExtra - bufsz * 0.25);
    }

    const writePos = Atomics.load(_ctrl, 0);
    const readPos = Atomics.load(_ctrl, 1);
    const ringFill = (writePos - readPos + RING_CAP) % RING_CAP;
    const targetFill = LOOKAHEAD + _adaptiveExtra;
    const maxFill = MAX_FILL + _adaptiveExtra;
    if (ringFill > maxFill) return;

    let elapsedFrames = Math.max(0, Math.floor((ctx.currentTime - _playheadStartTime) * SR));
    if (_producedFrames < elapsedFrames - maxFill) {
      resetPlayhead(ctx.currentTime);
      elapsedFrames = 0;
    }
    const targetProducedFrames = elapsedFrames + targetFill;
    const maxProducedFrames = elapsedFrames + maxFill;

    // Push only until the produced playhead reaches the lookahead window.
    let n = 0;
    while (
      _producedFrames + bufsz <= targetProducedFrames &&
      _producedFrames + bufsz <= maxProducedFrames &&
      ringFill + n * bufsz < maxFill &&
      n < MAX_BURST
    ) {
      if (!pushOne()) break;
      n++;
    }
  }

  function startPump() {
    if (_timerId) return;
    pump();
    // The >=70ms lookahead leaves room for an 8ms check cadence. Keep the
    // hardware-clock and ring-fill gates: fewer checks must not produce extra audio.
    _timerId = setInterval(pump, 8);
    log('AUDIO SP-shim: pump started (bufsz=' + bufsz + ' SR=' + SR +
        ' lookahead=' + Math.round(LOOKAHEAD) + 'fr / ' +
        (LOOKAHEAD * 1000 / SR).toFixed(0) + 'ms).', 'ok');
  }

  function tryFinalize() {
    if (!_wn || !_dest) return;
    _gain = ctx.createGain();
    _gain.gain.value = 1.0;
    _wn.connect(_gain);
    _gain.connect(_dest);
    if (_handler) startPump();
    log('AUDIO SP-shim: connected to destination.', 'ok');
  }

  (async () => {
    const ok = await ensureSpShimModule(ctx);
    if (!ok) { log('AUDIO: SP shim worklet load failed.', 'warn'); return; }
    try {
      if (typeof SharedArrayBuffer === 'undefined') {
        log('AUDIO: SharedArrayBuffer unavailable, SP shim cannot run without extra copies.', 'err');
        return;
      }
      const sab = new SharedArrayBuffer(32 + RING_CAP * nCh * 4);
      _ctrl = new Int32Array(sab, 0, 8);
      _data = new Float32Array(sab, 32, RING_CAP * nCh);
      _wn = new AudioWorkletNode(ctx, 'ppsspp-sp-shim', {
        numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [nCh],
        processorOptions: { channels: nCh, cap: RING_CAP, sab },
      });
      _wn.onprocessorerror = (e) =>
        log('AUDIO: SP shim processor error: ' + (e?.message || e), 'err');
      tryFinalize();
    } catch(e) {
      log('AUDIO: SP shim AudioWorkletNode failed: ' + (e?.message || e), 'err');
    }
  })();

  return {
    get onaudioprocess()   { return _handler; },
    set onaudioprocess(fn) {
      _handler = fn;
      // Handler assigned after connect? Start pump now.
      if (_wn && _dest && !_timerId) startPump();
    },
    connect(dest) { _dest = dest; tryFinalize(); },
    disconnect() {
      if (_timerId) { clearInterval(_timerId); _timerId = null; }
      try { if (_gain) _gain.disconnect(); } catch(e) {}
      try { if (_wn)   _wn.disconnect();   } catch(e) {}
    },
    addEventListener()    {},
    removeEventListener() {},
  };
}

async function installScriptProcessorPolyfill(ctx) {
  if (!ctx || !ctx.audioWorklet) {
    log('AUDIO: AudioWorklet not available — ScriptProcessor polyfill skipped.', 'warn');
    return;
  }
  // Pre-load the shim worklet module NOW (inside user gesture) so it's
  // ready before SDL synchronously calls createScriptProcessor.
  await ensureSpShimModule(ctx);

  // Patch AudioContext.prototype globally — covers SDL's own context too.
  const proto = AudioContext.prototype;
  if (proto._ppssppSpPatched) return;
  proto._ppssppSpPatched = true;

  const _origCreate = proto.createScriptProcessor;
  proto.createScriptProcessor = function(bufSize, nIn, nOut) {
    // Always use the shim — avoids Chrome's deprecated/broken native node
    // and the "onaudioprocess never fires" bug on Chrome 126+.
    // On Firefox/Safari the shim works identically.
    log('AUDIO: createScriptProcessor → WorkletShim (bufSz=' + bufSize +
        ', nCh=' + (nOut || 2) + ').', 'info');
    return makeScriptProcessorShim(this, bufSize, nIn, nOut);
  };
  log('AUDIO: ScriptProcessor→AudioWorklet polyfill active (all browsers).', 'ok');
}

/* ── Gamepad ────────────────────────────────────────────────────── */
function updateTouchControls() {
  if (!touchControlsInitialized) return;
  const settings = loadPlayerSettings();
  const rawMode = gamepadBridgeRawIndex >= 0;
  const enabled = !!touchControlMount && gamepadBridgeInstalled && runtimeReady && !runtimeFailed
    && settings.touch && !rawMode && !document.hidden
    && !document.body.classList.contains("panel-open")
    && byId("fsMenuToggle")?.getAttribute("aria-expanded") !== "true";
  touchControlMount?.setEnabled(enabled);
  if (!enabled) touchControlState?.reset();
  document.body.classList.toggle("touch-gamepad-visible", enabled);
  for (const id of ["touchGamepadToggle", "fsTouchGamepadToggle"]) {
    const toggle = byId(id);
    if (!toggle) continue;
    toggle.disabled = !gamepadBridgeInstalled || !runtimeReady || runtimeFailed;
    toggle.setAttribute("aria-pressed", String(settings.touch && !rawMode));
    toggle.title = touchControlError || (rawMode ? "启用屏幕手柄并切回标准输入" : settings.touch ? "隐藏屏幕手柄" : "显示屏幕手柄");
  }
  const checkbox = byId("player-touch-controls");
  if (checkbox) {
    checkbox.disabled = !gamepadBridgeInstalled;
    checkbox.title = touchControlError || (rawMode ? "当前使用非标准实体手柄；顶部手柄按钮可切回屏幕操作" : "立即显示或隐藏屏幕手柄");
  }
  if (touchControlError) {
    const status = byId("player-settings-status");
    if (status) status.textContent = touchControlError;
  }
  if (touchControlsVisible !== enabled) {
    touchControlsVisible = enabled;
    scheduleRuntimeResize();
  }
}

function toggleTouchControls() {
  if (!gamepadBridgeInstalled || !runtimeReady || runtimeFailed) return;
  const checkbox = byId("player-touch-controls");
  if (!checkbox) return;
  const enable = gamepadBridgeRawIndex >= 0 || !loadPlayerSettings().touch;
  if (enable && gamepadBridgeRawIndex >= 0) setActiveGamepadIndex(-1, "screen controls");
  checkbox.checked = enable;
  // Use the normal settings event so active diagnostic recordings see the change.
  checkbox.dispatchEvent(new Event("change", { bubbles: true }));
  setPanelOpen(false, false);
  setFullscreenMenuOpen(false, false);
  canvas?.focus({ preventScroll: true });
  void unlockAudio();
}

function dispatchLogicalGamepad(type, gamepad) {
  const event = new Event(type);
  Object.defineProperty(event, "gamepad", { value: gamepad });
  event.__ppssppLogical = true;
  window.dispatchEvent(event);
}

function releaseLogicalGamepad(gamepad) {
  let changed = false;
  for (let i = 0; i < gamepad.axes.length; i++) {
    if (gamepad.axes[i] !== 0) { gamepad.axes[i] = 0; changed = true; }
  }
  for (const button of gamepad.buttons) {
    if (button.value !== 0 || button.pressed || button.touched) {
      button.value = 0; button.pressed = false; button.touched = false; changed = true;
    }
  }
  if (changed) gamepad.timestamp = Math.max(performance.now(), gamepad.timestamp + 0.001);
}

function refreshSDLGamepadBridge(force = false) {
  if (!gamepadBridgeInstalled) return;
  const raw = getBrowserGamepads().find(pad => pad.index === activeGamepadIndex && pad.mapping !== "standard");
  const mode = raw ? JSON.stringify([raw.index, raw.id, raw.mapping, raw.axes.length, raw.buttons.length]) : "standard";
  if (!force && mode === gamepadBridgeMode) return;
  touchControlState.reset();
  if (gamepadBridgeCurrent) {
    releaseLogicalGamepad(gamepadBridgeCurrent);
    gamepadBridgeCurrent.connected = false;
    // SDL recenters and releases its opened joystick when it receives removal.
    if (started && window.Module) dispatchLogicalGamepad("gamepaddisconnected", gamepadBridgeCurrent);
  }
  gamepadBridgeRawIndex = raw ? raw.index : -1;
  gamepadBridgeMode = mode;
  const source = raw || touchControlState.gamepad;
  gamepadBridgeCurrent = { id: source.id, mapping: source.mapping, index: 0, connected: true,
    // SDL treats zero as an unsupported timestamp and compares every value.
    timestamp: Math.max(0.001, performance.now()), axes: Array.from(source.axes),
    buttons: Array.from(source.buttons, button => ({ value: button.value, pressed: !!button.pressed, touched: !!button.touched })) };
  releaseLogicalGamepad(gamepadBridgeCurrent);
  if (started && window.Module) dispatchLogicalGamepad("gamepadconnected", gamepadBridgeCurrent);
  if (raw) showToast("已使用非标准实体手柄的原映射，屏幕手柄暂时隐藏。顶部手柄按钮可切回屏幕操作。", 7000);
  updateTouchControls();
}

function getSDLGamepads() {
  const output = gamepadBridgeCurrent;
  if (!output) return [];
  const pads = getBrowserGamepads();
  // Compare the final neutral output while suspended, not a held physical input
  // followed by its release on every poll.
  if (runtimeFailed || document.hidden) {
    releaseLogicalGamepad(output);
    return [output];
  }
  let changed = false;
  if (gamepadBridgeRawIndex >= 0) {
    const raw = pads.find(pad => pad.index === gamepadBridgeRawIndex);
    if (raw) {
      // Preserve the browser's raw mapping and button/axis layout. Only the
      // exposed index is normalized; SDL's controller database still sees its ID.
      // Own these values: browsers may mutate native arrays in place or restart
      // their timestamp after reconnect, and releases must not modify the device.
      if (output.axes.length !== raw.axes.length || output.buttons.length !== raw.buttons.length) changed = true;
      output.axes.length = raw.axes.length;
      output.buttons.length = raw.buttons.length;
      for (let i = 0; i < raw.axes.length; i++) {
        if (output.axes[i] !== raw.axes[i]) { output.axes[i] = raw.axes[i]; changed = true; }
      }
      for (let i = 0; i < raw.buttons.length; i++) {
        const source = raw.buttons[i];
        const button = output.buttons[i] || (output.buttons[i] = { value: 0, pressed: false, touched: false });
        const pressed = !!source.pressed, touched = !!source.touched;
        if (button.value !== source.value || button.pressed !== pressed || button.touched !== touched) {
          button.value = source.value; button.pressed = pressed; button.touched = touched; changed = true;
        }
      }
    } else {
      releaseLogicalGamepad(output);
      return [output];
    }
  } else {
    const selected = pads.find(pad => pad.index === activeGamepadIndex);
    const physical = (selected ? [selected] : pads).filter(pad => pad.mapping === "standard");
    const screen = touchControlState.gamepad;
    for (let i = 0; i < output.buttons.length; i++) {
      let value = screen.buttons[i].value;
      for (const pad of physical) value = Math.max(value, Number(pad.buttons[i]?.value) || 0);
      value = Math.min(1, Math.max(0, value));
      const button = output.buttons[i], pressed = value > 0.5, touched = value > 0;
      if (button.value !== value || button.pressed !== pressed || button.touched !== touched) {
        button.value = value; button.pressed = pressed; button.touched = touched; changed = true;
      }
    }
    const screenStick = screen.axes[0] !== 0 || screen.axes[1] !== 0;
    for (let i = 0; i < output.axes.length; i++) {
      let value = screen.axes[i];
      // An active screen stick owns both axes so opposing physical input cannot
      // turn its vertical movement into an unexpected diagonal.
      if (!(i < 2 && screenStick)) {
        for (const pad of physical) {
          const candidate = Number(pad.axes[i]) || 0;
          if (Math.abs(candidate) > Math.abs(value)) value = candidate;
        }
      }
      value = Math.min(1, Math.max(-1, value));
      if (output.axes[i] !== value) { output.axes[i] = value; changed = true; }
    }
  }
  // SDL can skip its comparison loop when the logical values stay unchanged.
  // Actual changes still advance with a coarse clock or several polls per frame.
  if (changed) output.timestamp = Math.max(performance.now(), output.timestamp + 0.001);
  return [output];
}

function initializeTouchGamepad() {
  touchControlsInitialized = true;
  try {
    const api = globalThis.PpssppTouchControls;
    const element = byId("touchGamepad");
    if (!nativeGetGamepads || !api?.createState || !api?.mount || !element) throw new Error("当前页面未提供可用的屏幕手柄输入桥");
    touchControlState = api.createState({ now: () => performance.now(), index: 0 });
    touchControlMount = api.mount({ element, canvas, state: touchControlState, onInteraction() {
      canvas?.focus({ preventScroll: true });
      void unlockAudio();
    } });
    navigator.getGamepads = getSDLGamepads;
    if (navigator.getGamepads !== getSDLGamepads) throw new Error("浏览器不允许接入屏幕手柄");
    gamepadBridgeInstalled = true;
    refreshSDLGamepadBridge();
  } catch (error) {
    if (gamepadBridgeInstalled) navigator.getGamepads = nativeGetGamepads;
    gamepadBridgeInstalled = false;
    gamepadBridgeCurrent = null;
    gamepadBridgeMode = "";
    gamepadBridgeRawIndex = -1;
    touchControlMount?.destroy();
    touchControlMount = null;
    touchControlState = null;
    touchControlError = "屏幕手柄不可用：" + error.message;
    log(touchControlError, "warn");
  }
  updateTouchControls();
}

const connectedGamepads = new Map();
const GAMEPAD_POLL_MS = 1000;
const GAMEPAD_SDL_RECONNECT_MS = 5000;
const GAMEPAD_SELECT_KEY = "ppsspp_active_gamepad_index";
let gamepadPollTimer = 0;
let activeGamepadIndex = Number(preferences.getItem(GAMEPAD_SELECT_KEY) ?? -1);
if (!Number.isInteger(activeGamepadIndex)) activeGamepadIndex = -1;
window.__ppssppActiveGamepadIndex = activeGamepadIndex;
const nativeGetGamepads = navigator.getGamepads ? navigator.getGamepads.bind(navigator) : null;

function installGamepadSelectionFilter() {
  initializeTouchGamepad();
  if (gamepadBridgeInstalled) return;
  if (!nativeGetGamepads || navigator.__ppssppGamepadFiltered) return;
  try {
    Object.defineProperty(navigator, "__ppssppGamepadFiltered", { value: true });
    navigator.getGamepads = function() {
      const pads = nativeGetGamepads();
      if (!pads || !isActiveGamepadPresent()) return pads;

      const filtered = Array.from(pads);
      for (let i = 0; i < filtered.length; i++) {
        if (filtered[i] && filtered[i].index !== window.__ppssppActiveGamepadIndex)
          filtered[i] = null;
      }
      return filtered;
    };
  } catch(e) {
    log("GAMEPAD: controller filter unavailable in this browser: " + (e?.message || e), "warn");
  }
}

function isActiveGamepadPresent() {
  if (window.__ppssppActiveGamepadIndex < 0) return false;
  if (connectedGamepads.has(window.__ppssppActiveGamepadIndex)) return true;
  try {
    return !!nativeGetGamepads?.().find(gp => gp && gp.connected !== false && gp.index === window.__ppssppActiveGamepadIndex);
  } catch(e) {
    return false;
  }
}

function shouldHideGamepadFromSDL(gp) {
  return !!gp && isActiveGamepadPresent() && gp.index !== window.__ppssppActiveGamepadIndex;
}

window.addEventListener("gamepadconnected", e => {
  if (e.__ppssppLogical) return;
  if (gamepadBridgeInstalled) {
    e.stopImmediatePropagation();
    rememberGamepad(e.gamepad, "connected", { refreshSDL: false });
    refreshSDLGamepadBridge();
    return;
  }
  if (shouldHideGamepadFromSDL(e.gamepad)) {
    e.stopImmediatePropagation();
    rememberGamepad(e.gamepad, "available", { refreshSDL: false });
  }
}, true);
window.addEventListener("gamepaddisconnected", e => {
  if (e.__ppssppLogical) return;
  if (gamepadBridgeInstalled) {
    e.stopImmediatePropagation();
    connectedGamepads.delete(e.gamepad.index);
    updateGamepadSelector();
    refreshSDLGamepadBridge();
    return;
  }
  if (shouldHideGamepadFromSDL(e.gamepad)) {
    e.stopImmediatePropagation();
    connectedGamepads.delete(e.gamepad.index);
    updateGamepadSelector();
  }
}, true);

function redispatchSelectedGamepadConnection(reason) {
  if (gamepadBridgeInstalled) { refreshSDLGamepadBridge(); return; }
  if (activeGamepadIndex < 0 || typeof GamepadEvent !== "function") return;
  const gp = getBrowserGamepads().find(p => p.index === activeGamepadIndex);
  if (!gp) return;
  try {
    const ev = new GamepadEvent("gamepadconnected", { gamepad: gp });
    ev.__ppssppSynthetic = true;
    window.dispatchEvent(ev);
    log('GAMEPAD selected controller exposed to SDL: [' + gp.index + '] "' + gp.id + '" (' + reason + ')', "info");
  } catch(e) {
  }
}

function shortGamepadName(id) {
  return (id || "Gamepad").replace(/\s+/g, " ").trim().slice(0, 34);
}

function updateGamepadBadge() {
  if (!gamepadBadge) return;
  const n = connectedGamepads.size;
  if (n === 0) { gamepadBadge.textContent = "🎮 未连接手柄"; gamepadBadge.className = "badge"; }
  else {
    const active = connectedGamepads.get(activeGamepadIndex);
    const names = activeGamepadIndex >= 0 && active
      ? "Active: " + shortGamepadName(active.id).slice(0, 22)
      : [...connectedGamepads.values()].map(g => shortGamepadName(g.id).slice(0,22)).join(", ");
    gamepadBadge.textContent = "\uD83C\uDFAE " + n + ": " + names;
    gamepadBadge.className   = "badge active";
  }
}

function updateGamepadSelector() {
  if (!gamepadSelect) {
    updateGamepadBadge();
    return;
  }
  const previous = String(activeGamepadIndex);
  gamepadSelect.innerHTML = "";

  const auto = document.createElement("option");
  auto.value = "-1";
  auto.textContent = "全部手柄";
  gamepadSelect.appendChild(auto);

  const sorted = [...connectedGamepads.values()].sort((a, b) => a.index - b.index);
  for (const gp of sorted) {
    const opt = document.createElement("option");
    opt.value = String(gp.index);
    opt.textContent = "手柄 " + (gp.index + 1) + ": " + shortGamepadName(gp.id);
    gamepadSelect.appendChild(opt);
  }

  if (activeGamepadIndex >= 0 && !connectedGamepads.has(activeGamepadIndex)) {
    const missing = document.createElement("option");
    missing.value = previous;
    missing.textContent = "手柄 " + (activeGamepadIndex + 1) + "（等待连接）";
    gamepadSelect.appendChild(missing);
  }

  gamepadSelect.value = previous;
  gamepadSelect.disabled = !navigator.getGamepads;
  updateGamepadBadge();
}

function setActiveGamepadIndex(index, source = "selector") {
  const previous = activeGamepadIndex;
  activeGamepadIndex = Number.isInteger(index) ? index : -1;
  window.__ppssppActiveGamepadIndex = activeGamepadIndex;
  preferences.setItem(GAMEPAD_SELECT_KEY, String(activeGamepadIndex));

  const gp = connectedGamepads.get(activeGamepadIndex);
  const label = activeGamepadIndex < 0 ? "全部手柄" : (gp ? shortGamepadName(gp.id) : "手柄 " + (activeGamepadIndex + 1));
  log("GAMEPAD active controller: " + label + " (" + source + ")", "info");
  updateGamepadSelector();
  if (gamepadBridgeInstalled) refreshSDLGamepadBridge(previous !== activeGamepadIndex);
  else {
    reconnectKnownGamepadsForSDL("controller select", true);
    redispatchSelectedGamepadConnection("controller select");
  }
  canvas?.focus();
}

function flashGamepadBadge() {
  if (!gamepadBadge) return;
  gamepadBadge.style.transition = "none";
  gamepadBadge.style.outline    = "2px solid var(--accent)";
  setTimeout(() => { gamepadBadge.style.transition = ""; gamepadBadge.style.outline = ""; }, 800);
}

function getBrowserGamepads() {
  try {
    return nativeGetGamepads ? Array.from(nativeGetGamepads()).filter(pad => pad && pad.connected !== false) : [];
  } catch(e) {
    log("GAMEPAD: scan failed: " + (e?.message || e), "warn");
    return [];
  }
}

function gamepadInfo(gp) {
  return {
    id: gp.id || "Gamepad",
    index: gp.index,
    mapping: gp.mapping || "",
    axes: gp.axes?.length || 0,
    buttons: gp.buttons?.length || 0,
    timestamp: gp.timestamp || 0,
    lastSeen: performance.now(),
    lastSDLReconnect: connectedGamepads.get(gp.index)?.lastSDLReconnect || 0,
  };
}

function dispatchSDLGamepadReconnect(gp, reason, force = false) {
  if (gamepadBridgeInstalled) return false;
  const state = connectedGamepads.get(gp.index);
  if (!started || !window.Module || !state) return false;

  const now = performance.now();
  if (!force && now - state.lastSDLReconnect < GAMEPAD_SDL_RECONNECT_MS) return false;
  state.lastSDLReconnect = now;

  try {
    if (typeof GamepadEvent !== "function") return false;
    const ev = new GamepadEvent("gamepadconnected", { gamepad: gp });
    ev.__ppssppSynthetic = true;
    window.dispatchEvent(ev);
    log('GAMEPAD reconnect hint for SDL: [' + gp.index + '] "' + gp.id + '" (' + reason + ')', "info");
    return true;
  } catch(e) {
    return false;
  }
}

function rememberGamepad(gp, source, options = {}) {
  if (!gp || gp.connected === false) return false;

  const prev = connectedGamepads.get(gp.index);
  const next = gamepadInfo(gp);
  if (prev) {
    next.lastSDLReconnect = prev.lastSDLReconnect;
    connectedGamepads.set(gp.index, next);
    return false;
  }

  connectedGamepads.set(gp.index, next);
  log('GAMEPAD ' + source + ': [' + gp.index + '] "' + gp.id + '" axes=' + next.axes + ' buttons=' + next.buttons + ' mapping="' + next.mapping + '"', "ok");
  updateGamepadSelector();
  flashGamepadBadge();
  if (options.refreshSDL) dispatchSDLGamepadReconnect(gp, source, options.forceSDL);
  if (gamepadBridgeInstalled && gp.mapping !== "standard" && activeGamepadIndex < 0)
    showToast("检测到非标准实体手柄，请在手柄列表选择它以使用原映射；屏幕手柄仍可使用。", 7000);
  return true;
}

function reconcileGamepads(source = "scan", options = {}) {
  const pads = getBrowserGamepads();
  const present = new Set();
  let added = false;
  for (const gp of pads) {
    if (!gp || gp.connected === false) continue;
    present.add(gp.index);
    added = rememberGamepad(gp, source, options) || added;
  }

  let removed = false;
  for (const [index, state] of connectedGamepads) {
    if (!present.has(index)) {
      connectedGamepads.delete(index);
      removed = true;
      log('GAMEPAD missing: [' + index + '] "' + state.id + '"');
    }
  }

  if (removed || added) updateGamepadSelector();
  if (!pads.length && options.verbose)
    log("GAMEPAD: no controller detected. Press a button once if the browser is hiding it.", "warn");
  refreshSDLGamepadBridge();
  return pads.length;
}

function reconnectKnownGamepadsForSDL(reason, force = false) {
  if (gamepadBridgeInstalled) {
    refreshSDLGamepadBridge();
    if (started && window.Module && gamepadBridgeCurrent) dispatchLogicalGamepad("gamepadconnected", gamepadBridgeCurrent);
    return gamepadBridgeCurrent ? 1 : 0;
  }
  let n = 0;
  for (const gp of getBrowserGamepads()) {
    if (!gp || gp.connected === false) continue;
    rememberGamepad(gp, reason);
    if (dispatchSDLGamepadReconnect(gp, reason, force)) n++;
  }
  if (n > 0) {
    flashGamepadBadge();
  }
  return n;
}

function startSmartGamepadPolling() {
  if (gamepadPollTimer || !navigator.getGamepads) return;
  reconcileGamepads("startup scan");
  gamepadPollTimer = setInterval(() => {
    if (!document.hidden) reconcileGamepads("runtime scan", { refreshSDL: true });
  }, GAMEPAD_POLL_MS);
}

function onGamepadConnected(e) {
  if (e.__ppssppLogical) return;
  const gp = e.gamepad;
  rememberGamepad(gp, e.__ppssppSynthetic ? "refreshed" : "connected", { refreshSDL: false });
}
function onGamepadDisconnected(e) {
  if (e.__ppssppLogical) return;
  const gp = e.gamepad; connectedGamepads.delete(gp.index);
  log('GAMEPAD disconnected: [' + gp.index + '] "' + gp.id + '"');
  updateGamepadSelector();
}
window.addEventListener("gamepadconnected",    onGamepadConnected);
window.addEventListener("gamepaddisconnected", onGamepadDisconnected);

function probeExistingGamepads() {
  reconcileGamepads("present", { verbose: true, refreshSDL: true, forceSDL: true });
}

function showGamepadDiag() {
  if (!navigator.getGamepads) { log("GAMEPAD: navigator.getGamepads API unavailable.", "warn"); return; }
  let found = 0;
  for (const gp of getBrowserGamepads()) {
    if (!gp) continue; found++;
    const axes = Array.from(gp.axes).map(v=>v.toFixed(2)).join(", ");
    const btns = Array.from(gp.buttons).map((b,i)=>b.pressed?"B"+i+"("+b.value.toFixed(2)+")":null).filter(Boolean).join(", ")||"none";
    log('GAMEPAD[' + gp.index + '] "' + gp.id.slice(0,60) + '" mapping=' + gp.mapping);
    log("  axes=[" + axes + "]");
    log("  pressed=[" + btns + "]");
  }
  if (!found) log("GAMEPAD: no controller detected — press a button on your controller first.", "warn");
}

on(gamepadSelect, "change", () => {
  const index = Number(gamepadSelect.value);
  setActiveGamepadIndex(Number.isInteger(index) ? index : -1);
});
on(gamepadSelect, "pointerdown", () => {
  probeExistingGamepads();
  reconnectKnownGamepadsForSDL("controller menu", false);
});
on(gamepadSelect, "focus", () => {
  probeExistingGamepads();
});
window.addEventListener("focus", () => {
  startSmartGamepadPolling();
  reconnectKnownGamepadsForSDL("window focus");
});
document.addEventListener("visibilitychange", () => {
  updateTouchControls();
  if (!document.hidden) reconnectKnownGamepadsForSDL("page visible");
});
window.addEventListener("blur", () => touchControlState?.reset());
window.addEventListener("pagehide", () => touchControlState?.reset());
on("touchGamepadToggle", "click", toggleTouchControls);
on("fsTouchGamepadToggle", "click", toggleTouchControls);
installGamepadSelectionFilter();
updateGamepadSelector();
startSmartGamepadPolling();

/* ── GPU probe ──────────────────────────────────────────────────── */
function renderGpuBadge(text, className, title) {
  if (!gpuBadge) return;
  if (className) gpuBadge.className = className;
  if (title) gpuBadge.title = title;
  gpuBadge.innerHTML = '<span class="badge-icon" aria-hidden="true"><i data-lucide="monitor"></i></span><span class="badge-marquee-viewport"><span class="badge-marquee-track"><span class="badge-marquee-text">' + text + '</span></span></span>';
  if (window.lucide && window.lucide.createIcons) {
    try { window.lucide.createIcons({ root: gpuBadge }); } catch (e) {}
  }
  const checkMarquee = () => {
    if (!gpuBadge) return;
    const vp = gpuBadge.querySelector('.badge-marquee-viewport');
    const tr = gpuBadge.querySelector('.badge-marquee-track');
    const txt = gpuBadge.querySelector('.badge-marquee-text');
    if (!vp || !tr || !txt) return;
    if (txt.scrollWidth > vp.clientWidth + 2) {
      gpuBadge.classList.add('is-overflowing');
      if (!tr.querySelector('.badge-marquee-dup')) {
        const sep = document.createElement('span');
        sep.className = 'badge-marquee-sep';
        sep.textContent = '　·　';
        const dup = document.createElement('span');
        dup.className = 'badge-marquee-dup';
        dup.textContent = text;
        dup.setAttribute('aria-hidden', 'true');
        tr.appendChild(sep);
        tr.appendChild(dup);
      }
    } else {
      gpuBadge.classList.remove('is-overflowing');
      const dup = tr.querySelector('.badge-marquee-dup');
      const sep = tr.querySelector('.badge-marquee-sep');
      if (dup) dup.remove();
      if (sep) sep.remove();
    }
  };
  requestAnimationFrame(checkMarquee);
  window.addEventListener('resize', checkMarquee, { passive: true });
}

function probeWebGLFeaturesWithPref(powerPreference) {
  const pc = document.createElement("canvas");
  let gl = null;
  try { gl = pc.getContext("webgl2", { powerPreference, alpha: false, antialias: false, depth: true, stencil: true, preserveDrawingBuffer: false }); }
  catch (error) { log("WebGL2 probe failed: " + error.message, "warn"); }
  let simd = false;
  try { simd = WebAssembly.validate(new Uint8Array([0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,10,1,8,0,65,0,253,15,253,98,11])); } catch(e) {}
  const capabilities = { webgl2: !!gl, simd, crossOriginIsolated: !!window.crossOriginIsolated,
    sharedArrayBuffer: typeof SharedArrayBuffer === "function" };
  setInfoVal("iWebgl2", gl ? "yes" : "no", gl ? "good" : "bad");
  setInfoVal("iSIMD", simd ? "yes" : "no", simd ? "good" : "bad");
  setInfoVal("iHWC", String(navigator.hardwareConcurrency || "?"));
  setInfoVal("iCOI", String(capabilities.crossOriginIsolated), capabilities.crossOriginIsolated ? "good" : "bad");
  setInfoVal("iSAB", capabilities.sharedArrayBuffer ? "yes" : "no", capabilities.sharedArrayBuffer ? "good" : "bad");
  if (!gl) {
    log("WebGL2 unavailable — GLES3/WebGL2 rendering cannot start.", "err");
    if (gpuBadge) {
      renderGpuBadge("不支持 WebGL2", "badge error", "当前浏览器环境不支持 WebGL2");
    }
    return capabilities;
  }
  const dbg      = gl.getExtension("WEBGL_debug_renderer_info");
  const renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  const vendor   = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL)   : gl.getParameter(gl.VENDOR);
  const version  = gl.getParameter(gl.VERSION);
  const glslVer  = gl.getParameter(gl.SHADING_LANGUAGE_VERSION);
  const maxTex   = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  const anisoExt = gl.getExtension("EXT_texture_filter_anisotropic");
  const maxAniso = anisoExt ? gl.getParameter(anisoExt.MAX_TEXTURE_MAX_ANISOTROPY_EXT) : 1;
  const hasStencil   = !!gl.getExtension("WEBGL_stencil_texturing");
  const hasMultiDraw = !!gl.getExtension("WEBGL_multi_draw");
  log("GPU: " + renderer);
  log("GPU vendor: " + vendor);
  log("WebGL: " + version);
  log("GLSL: " + glslVer);
  log("MaxTexture: " + maxTex + " | MaxAnisotropy: " + maxAniso);
  log("stencil_texturing: " + hasStencil + " | multi_draw: " + hasMultiDraw, hasStencil ? undefined : "warn");
  if (!hasStencil) log("WARNING: without WEBGL_stencil_texturing some games may show black scenes.", "warn");

  setInfoVal("iRenderer", renderer);
  setInfoVal("iVendor",   vendor);
  setInfoVal("iVersion",  version);
  setInfoVal("iGlsl",     glslVer);
  setInfoVal("iMaxTex",   String(maxTex));
  setInfoVal("iAniso",    String(maxAniso));
  setInfoVal("iStencil",  hasStencil   ? "yes" : "no", hasStencil   ? "good" : "warn");
  setInfoVal("iMultiDraw",hasMultiDraw ? "yes" : "no", hasMultiDraw ? "good" : "");
  const cleanRenderer = renderer.replace(/\(.*?\)/g, "").replace(/\s+/g, " ").trim();
  if (gpuBadge) {
    const gpuTitle = "[" + powerPreference + "]\n" + renderer + "\n" + vendor + "\n" + version + "\nGLSL: " + glslVer + "\nMaxTex: " + maxTex + "  MaxAniso: " + maxAniso + "\nstencil_texturing: " + hasStencil + "  multi_draw: " + hasMultiDraw;
    renderGpuBadge(cleanRenderer, "badge active", gpuTitle);
  }
  // The probe is disposable; release its GPU resources before starting SDL.
  gl.getExtension("WEBGL_lose_context")?.loseContext();
  return capabilities;
}

function probeWebGLFeatures() { probeWebGLFeaturesWithPref(gpuSelectEl?.value || "high-performance"); }

on(gpuSelectEl, "change", () => {
  log('GPU selector changed to "' + gpuSelectEl.value + '" — re-probing WebGL...');
  probeWebGLFeaturesWithPref(gpuSelectEl.value);
});

/* ── Error handlers ─────────────────────────────────────────────── */
window.addEventListener("error",             (e) => log("JS ERROR: " + (e.message || e.error || "unknown"), "err"));
window.addEventListener("unhandledrejection",(e) => log("PROMISE ERROR: " + (e.reason?.stack || e.reason || "unknown"), "err"));

const COI_RELOAD_KEY = "ppsspp-coi-reload-count";

async function reloadForCrossOriginIsolation(reason) {
  if (window.crossOriginIsolated) {
    if (typeof SharedArrayBuffer !== "function") {
      setStatus("当前浏览器未开放运行所需的共享内存。如果在应用内打开，请尝试使用完整浏览器。", "err");
      hideLoading();
      return false;
    }
    try { sessionStorage.removeItem(COI_RELOAD_KEY); } catch (_) {}
    return true;
  }

  let attempts;
  try { attempts = Number(sessionStorage.getItem(COI_RELOAD_KEY) || "0"); }
  catch (_) {
    setStatus("浏览器阻止了网站存储。请允许此网站保存数据后重新载入。", "err");
    hideLoading();
    return false;
  }
  if (attempts >= 3) {
    log("Cross-origin isolation still unavailable after reload attempts. SharedArrayBuffer cannot be used on this page.", "err");
    setStatus("当前浏览器未能启用跨源隔离和共享内存。如果在应用内打开，请尝试使用完整浏览器；网站需使用安全连接并设置 COOP/COEP 响应头。", "err");
    hideLoading();
    setStartButtonMode("idle");
    return false;
  }

  if (!("serviceWorker" in navigator)) {
    log("Service workers are unavailable; isolation recovery requires site COOP/COEP headers.", "err");
    setStatus("当前浏览器无法修复运行所需的跨源隔离和共享内存。如果在应用内打开，请尝试使用完整浏览器；网站需使用安全连接并设置 COOP/COEP 响应头。", "err");
    hideLoading();
    return false;
  }

  try { sessionStorage.setItem(COI_RELOAD_KEY, String(attempts + 1)); }
  catch (_) {
    setStatus("浏览器阻止了网站存储，请允许此网站保存数据后重新载入。", "err");
    hideLoading();
    return false;
  }
  log("Cross-origin isolation required for WASM threads; reloading through service worker" + (reason ? " (" + reason + ")" : "") + ".", "warn");
  setStatus("尚未启用跨源隔离和共享内存，正在尝试准备运行环境…", "run");
  showLoading("正在准备运行环境…");

  let timeout;
  try {
    await Promise.race([
      (async () => {
        await navigator.serviceWorker.register("sw.js", { scope: "./" });
        await navigator.serviceWorker.ready;
      })(),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("等待浏览器运行环境超时")), 10000); }),
    ]);
  } catch(e) {
    log("SW registration before isolation reload failed: " + (e?.message || e), "warn");
    setStatus("运行环境准备失败，尚未启用跨源隔离和共享内存。如果在应用内打开，请尝试使用完整浏览器；网站需使用安全连接并设置 COOP/COEP 响应头。可导出诊断报告查看原因。", "err");
    hideLoading();
    setStartButtonMode("idle");
    return false;
  } finally {
    clearTimeout(timeout);
  }

  location.reload();
  return false;
}

/* ── Asset / game loading ───────────────────────────────────────── */
function dirname(p) { const s = p.lastIndexOf("/"); return s === -1 ? "" : p.slice(0, s); }

async function preloadAssets(FS) {
  const atlasMeta = VIRTUAL_ASSETS + "/font_atlas.meta";
  const atlasZim = VIRTUAL_ASSETS + "/font_atlas.zim";
  if (USE_PRELOADED_ASSETS) {
    log("Assets are provided by PPSSPPSDL.data; waiting on Emscripten preload dependencies.", "ok");
    return;
  }

  if (FS.analyzePath(atlasMeta).exists && FS.analyzePath(atlasZim).exists) {
    log("Assets already mounted by Emscripten preload package.", "ok");
    return;
  }

  log("Fetching asset manifest: " + MANIFEST);
  const r = await fetch(MANIFEST, { cache: "no-store" });
  if (!r.ok) throw new Error("Asset manifest not found: " + r.status);
  const files = (await r.text()).split("\n").map(l=>l.trim()).filter(Boolean);
  FS.mkdirTree(VIRTUAL_ASSETS);
  log("Assets in manifest: " + files.length);
  let idx = 0;
  const workers = Math.min(8, Math.max(2, navigator.hardwareConcurrency || 4), files.length);
  async function loadNext() {
    while (idx < files.length) {
      const i = idx++, rel = files[i];
      const target = VIRTUAL_ASSETS + "/" + rel;
      const dir = dirname(target); if (dir) FS.mkdirTree(dir);
      setStatus("正在载入资源 " + (i+1) + "/" + files.length + ": " + rel, "run");
      showLoading("正在载入模拟器资源… " + (i+1) + " / " + files.length, (i+1) / files.length);
      const res = await fetch(ASSET_DIR + rel);
      if (!res.ok) throw new Error("Asset not found: " + rel + " (" + res.status + ")");
      FS.writeFile(target, new Uint8Array(await res.arrayBuffer()));
    }
  }
  await Promise.all(Array.from({ length: workers }, loadNext));
  if (!FS.analyzePath(atlasMeta).exists)
    throw new Error("Critical asset missing: font_atlas.meta");
  if (!FS.analyzePath(atlasZim).exists)
    throw new Error("Critical asset missing: font_atlas.zim");
  log("All assets loaded into MEMFS.", "ok");
}

async function preloadStoredGames(FS) {
  const games = await opfsWalk(OPFS_GAMES_DIR, "", false);
  if (!games.length) {
    log("OPFS games: no stored game files.", "dim");
    return 0;
  }

  FS.mkdirTree(VIRTUAL_GAME_DIR);
  const favorites = prunePreloadFavorites(games.map(game => game.path)).filter(name => name !== selectedStoredGame);
  if (!favorites.length) {
    log("OPFS games: " + games.length + " stored file(s) available. No startup preload games selected.", "ok");
    return 0;
  }

  let ok = 0;
  let bytesMounted = 0;
  for (const name of favorites) {
    if (selectedGame && name === selectedGame.name.replace(/[^a-zA-Z0-9._-]/g, "_")) continue;
    const target = VIRTUAL_GAME_DIR + "/" + name;
    if (FS.analyzePath?.(target)?.exists) continue;
    try {
      setStatus("正在载入游戏 " + (ok + 1) + "/" + favorites.length + ": " + name, "run");
      showLoading("正在载入游戏：" + name);
      const file = await opfsGetGameFile(name);
      mountBrowserGame(FS, file, name);
      ok++;
      bytesMounted += file.size;
      log("Startup registered file: " + target + " (" + formatBytes(file.size) + ")", "ok");
    } catch(e) {
      log("Startup preload failed " + name + ": " + e.message, "warn");
    }
  }
  log("OPFS games: preloaded " + ok + "/" + favorites.length + " game file(s) into " + VIRTUAL_GAME_DIR + " (" + formatBytes(bytesMounted) + ").", "ok");
  return ok;
}

function mountBrowserGame(FS, file, safeName) {
  const files = globalThis.PpssppBrowserFiles;
  if (!files) throw new Error("按需读取组件未准备好，请重新载入页面");
  if (runtimeReady && !files.hasFiles()) throw new Error("请先同步存档，再刷新页面并选择游戏后启动");
  const path = VIRTUAL_GAME_DIR + "/" + safeName;
  if (files.has(path)) throw new Error("同名游戏已经载入，请重新载入页面后切换");
  files.register(path, file);
  try { files.mirror(FS, path); }
  catch (error) { files.unregister(path); throw error; }
  return path;
}

async function preloadGame(FS) {
  if (!selectedGame && !selectedStoredGame) return null;
  const sourceName = selectedGame ? selectedGame.name : selectedStoredGame;
  const safe = sourceName.replace(/[^a-zA-Z0-9._-]/g, "_");
  setStatus("正在准备游戏：" + sourceName, "run");
  showLoading("正在准备游戏：" + sourceName);
  const file = selectedGame || await opfsGetGameFile(selectedStoredGame);
  const path = mountBrowserGame(FS, file, safe);
  log("Game registered for bounded reads: " + path + " (" + formatBytes(file.size) + ")", "ok");
  return path;
}

/* ── Panel navigation ───────────────────────────────────────────── */
function activatePanelTab(tabName, focus = false) {
  const name = tabName || "library";
  const id = "tab" + name.charAt(0).toUpperCase() + name.slice(1);
  const panel = document.getElementById(id);
  if (!panel) return;
  document.querySelectorAll("#panelTabList .tab").forEach(tab => {
    const selected = tab.dataset.tab === name;
    tab.classList.toggle("active", selected);
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
    if (selected && focus) {
      tab.focus({ preventScroll: true });
      tab.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  });
  document.querySelectorAll("#sidePanel .tab-panel").forEach(candidate => {
    candidate.classList.toggle("active", candidate === panel);
    candidate.hidden = candidate !== panel;
  });
  if (name === "log") { flushLog(); renderLog(); }
  if (name === "library") refreshLibrary();
  if (name === "drive") initDriveConfigUI();
  if (name === "network") { updateNetworkConfigUI(); checkNetworkWhenVisible(); }
}

function onPanelTabKeyDown(event) {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  const tabs = [...document.querySelectorAll("#panelTabList .tab")];
  const current = tabs.indexOf(event.currentTarget);
  if (current < 0) return;
  let next;
  switch (event.key) {
    case "ArrowRight": next = (current + 1) % tabs.length; break;
    case "ArrowLeft": next = (current + tabs.length - 1) % tabs.length; break;
    case "Home": next = 0; break;
    case "End": next = tabs.length - 1; break;
    default: return;
  }
  event.preventDefault();
  activatePanelTab(tabs[next].dataset.tab, true);
}

document.querySelectorAll("#panelTabList .tab").forEach(tab => {
  tab.addEventListener("click", () => activatePanelTab(tab.dataset.tab, true));
  tab.addEventListener("keydown", onPanelTabKeyDown);
});

/* ── FPS counter ────────────────────────────────────────────────── */
let fpsFrames = 0, fpsLast = performance.now();
(function tickFps() {
  fpsFrames++;
  const now = performance.now();
  if (now - fpsLast >= 1000) {
    const fps = Math.round(fpsFrames * 1000 / (now - fpsLast));
    fpsFrames = 0; fpsLast = now;
    if (started && fpsBadge && !fullscreenElement()) {
      fpsBadge.style.display = "block";
      fpsBadge.textContent = fps + " Hz · 页面刷新率";
    } else if (fpsBadge) {
      fpsBadge.style.display = "none";
    }
  }
  requestAnimationFrame(tickFps);
})();

async function exportDiagnosticReport() {
  const configs = [];
  try {
    const entries = await opfsWalk(OPFS_PERSIST_DIR, "", false);
    for (const entry of entries.filter(e => /\.ini$/i.test(e.path))) {
      let text;
      try { text = window.FS ? new TextDecoder().decode(window.FS.readFile(entry.path)) : new TextDecoder().decode(await opfsRead(entry.path)); }
      catch (_) { text = new TextDecoder().decode(await opfsRead(entry.path)); }
      let include = false;
      const settings = text.split(/\r?\n/).filter(line => {
        const section = line.match(/^\s*\[([^\]]+)\]/);
        if (section) include = /^(CPU|Graphics|Sound|PostShaderList|PostShaderSetting)$/.test(section[1]);
        return include;
      }).join("\n");
      configs.push({ name: entry.name, settings });
    }
  } catch (e) { configs.push({ error: e.message }); }
  const report = {
    version: 1, created: new Date().toISOString(),
    browser: navigator.userAgent, platform: navigator.platform,
    hardwareConcurrency: navigator.hardwareConcurrency, deviceMemoryGB: navigator.deviceMemory,
    crossOriginIsolated: window.crossOriginIsolated, sharedArrayBuffer: typeof SharedArrayBuffer !== "undefined",
    opfsAvailable: hasOPFS(), buildDirectory: BUILD_DIR, coreRevision: BUILD_STAMP,
    runtimeReady, status: statusEl?.textContent,
    gameReads: globalThis.PpssppBrowserFiles?.stats(),
    graphics: ["iRenderer", "iVendor", "iVersion"].map(id => ({ name: id, value: byId(id)?.textContent })),
    audio: { ...audioDebug }, configs,
    logs: [...logLines, ...pendingLines].slice(-500).map(line => line.raw
      .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
      .replace(/([?&#](?:access_token|id_token|session_key|code|state)=)[^&\s]+/gi, "$1[redacted]")),
  };
  triggerDownload(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }), "ppsspw-diagnostics.json");
}

function initializePerformancePanel() {
  const perf = globalThis.PpssppPerformance;
  if (!perf) return;
  perf.setSource(() => ({
    coreRevision: BUILD_STAMP,
    build: performanceBuildInfo,
    settings: performanceLaunchSettings || loadPlayerSettings(), settingsApplied: !!performanceLaunchSettings,
    wasmMemoryBytes: window.Module?.HEAPU8?.byteLength || window.HEAPU8?.byteLength,
    canvasWidth: canvas?.width, canvasHeight: canvas?.height,
    io: globalThis.PpssppBrowserFiles?.stats(),
    audio: { underruns: audioDebug.underruns, droppedFrames: audioDebug.ringDropped + audioDebug.fallbackDropped, callbacks: audioDebug.callbacks },
  }));
  const render = state => {
    const start = byId("performanceStartBtn"), stop = byId("performanceStopBtn"), save = byId("performanceExportBtn");
    if (start) start.disabled = state.active;
    if (stop) stop.disabled = !state.active;
    if (save) save.disabled = state.totalSamples === 0;
    const status = byId("performanceStatus");
    if (status) status.textContent = state.active ? "正在采样 · " + Math.floor(state.durationMs / 1000) + " 秒"
      : state.totalSamples ? "采样已停止 · " + state.totalSamples + " 个样本" : "尚未开始采样";
    const format = (value, unit) => value == null ? "—" : value.toFixed(1) + unit;
    setInfoVal("performanceCoreFps", format(state.core?.actualFps, " FPS"));
    setInfoVal("performanceSpeed", format(state.core?.speedPercent, "%"));
    setInfoVal("performancePageHz", format(state.pageHz, " Hz"));
    setInfoVal("performanceMemory", state.wasmMemoryBytes == null ? "—" : (state.wasmMemoryBytes / 1048576).toFixed(0) + " MiB");
  };
  perf.subscribe(render);
  on("performanceStartBtn", "click", () => perf.start());
  on("performanceStopBtn", "click", () => perf.stop());
  on("performanceExportBtn", "click", () => {
    triggerDownload(new Blob([JSON.stringify(perf.snapshot(), null, 2)], { type: "application/json" }), "ppsspw-performance.json");
  });
  window.addEventListener("pagehide", () => perf.stop());
}

async function resetEmulatorSettings() {
  if (started && !runtimeFailed) { showToast("请先在游戏内存档并同步到本机，再重新载入页面；启动前可以重置模拟器设置。"); return; }
  if (!confirm("重置模拟器设置吗？游戏、存档和手柄映射会保留，原设置也会备份。")) return;
  try {
    await persistQueue;
    const entries = await opfsWalk(OPFS_PERSIST_DIR, "", false);
    const configs = entries.filter(e => /\/PSP\/SYSTEM\/[^/]+\.ini$/i.test(e.path) && !/\/controls\.ini$/i.test(e.path));
    for (const { path } of configs) {
      await opfsPut(path + ".recovery-backup", await opfsRead(path));
      await opfsDelete(path);
      try { window.FS?.unlink(path); } catch (_) {}
      _persistedFileState.delete(path);
    }
    await resetPlayerSettings();
    showToast("设置已重置。重新载入页面后将使用默认设置。", 6000);
    log("Recovery: reset " + configs.length + " emulator settings file(s); saves retained.", "ok");
  } catch (e) { showToast("重置设置失败：" + e.message, 6000); }
}
on("diagnosticReportBtn", "click", exportDiagnosticReport);
on("recoveryReportBtn", "click", exportDiagnosticReport);
on("resetEmulatorSettingsBtn", "click", resetEmulatorSettings);
on("recoverySettingsBtn", "click", resetEmulatorSettings);
on("recoveryReloadBtn", "click", () => location.reload());

function failRuntime(message) {
  runtimeFailed = true;
  clearTimeout(window.ModuleStartupWatchdog);
  runtimeReady = false;
  updateTouchControls();
  hideLoading();
  setStatus(message, "err");
  const failureMessage = byId("runtimeFailureMessage");
  if (failureMessage) failureMessage.textContent = message;
  const recovery = byId("runtimeRecovery");
  if (recovery) recovery.hidden = false;
}

function handleBrowserGameReadError(event) {
  if (!started || runtimeFailed) return;
  const detail = event.detail;
  log("Game file read failed: " + (detail?.path || "unknown") + ": " + (detail?.message || "unknown"), "err");
  failRuntime("游戏文件读取失败。请重新载入页面并重新选择游戏文件；若使用本机缓存，请重新下载游戏。已同步到本机的存档会保留。");
}
window.addEventListener("ppsspp:game-read-error", handleBrowserGameReadError);

canvas?.addEventListener("pointerdown", () => canvas.focus({ preventScroll: true }));
canvas?.addEventListener("contextmenu", event => event.preventDefault());
canvas?.addEventListener("selectstart", event => event.preventDefault());

canvas?.addEventListener("webglcontextlost", event => {
  event.preventDefault();
  if (started) failRuntime("游戏画面连接已中断。请重新载入页面；已同步到本机的存档会保留。");
});

/* ── Launch ─────────────────────────────────────────────────────── */
async function start() {
  if (started) return;
  if (!validateGameSelection(selectedGame || selectedStoredGame)) return;
  if (!canvas) {
    setStatus("游戏画面尚未准备好，请重新载入页面。", "err");
    return;
  }
  const capabilities = probeWebGLFeaturesWithPref(gpuSelectEl?.value || "high-performance");
  const missing = [];
  if (!capabilities.webgl2) missing.push("WebGL2 图形支持");
  if (!capabilities.simd) missing.push("WebAssembly SIMD 向量指令支持");
  if (!capabilities.crossOriginIsolated) missing.push("跨源隔离");
  if (!capabilities.sharedArrayBuffer) missing.push("共享内存");
  if (missing.length) {
    setStatus("无法启动模拟器，当前环境缺少：" + missing.join("、") + "。如果在应用内打开，请尝试使用完整浏览器。"
      + (!capabilities.crossOriginIsolated ? "网站需使用安全连接并设置 COOP/COEP 响应头。" : ""), "err");
    hideLoading();
    if (!capabilities.crossOriginIsolated && capabilities.webgl2 && capabilities.simd) await reloadForCrossOriginIsolation("launch");
    return;
  }
  try { sessionStorage.removeItem(COI_RELOAD_KEY); } catch (_) {}
  started = true;
  globalThis.PpssppPerformance?.mark("launchClick");
  document.body.classList.add("emulator-started");
  log("Launch button clicked.", "info");
  setStartButtonMode("loading");
  const startupWatchdog = setTimeout(() => {
    if (!runtimeReady) failRuntime("启动等待超时，请导出错误详情，或重新载入页面后重试。");
  }, 120000);
  window.ModuleStartupWatchdog = startupWatchdog;
  fileLabel?.classList.add("disabled");
  if (fileInput) fileInput.disabled = true;
  if (gpuSelectEl) gpuSelectEl.disabled = true;
  setPanelOpen(false, false);
  setFullscreenMenuOpen(false, false);
  canvas.focus({ preventScroll: true });
  showLoading("正在准备声音…");
  let preAudioCtx = null;
  try {
    preAudioCtx = new AudioContext({ latencyHint: "interactive" });
    await preAudioCtx.resume();
    log("AUDIO: AudioContext pre-initialized for SDL (state=" + preAudioCtx.state + ", sr=" + preAudioCtx.sampleRate + ").", "ok");
    // Install ScriptProcessor→AudioWorklet polyfill for Chrome 126+ compat.
    // This MUST run inside the user gesture (button click) so the worklet
    // module loads on the already-running AudioContext.
    await installScriptProcessorPolyfill(preAudioCtx);
  } catch(e) { log("AUDIO: pre-init AudioContext failed: " + (e?.message || e), "warn"); }

  try {
    // Keep game snapshots stable until this page closes or reloads. Failures
    // after mounting also keep the lease, since the core may retain references.
    await globalThis.PpssppGameStorage.acquireShared();
  } catch (error) {
    started = false;
    clearTimeout(window.ModuleStartupWatchdog);
    document.body.classList.remove("emulator-started");
    fileLabel?.classList.remove("disabled");
    if (fileInput) fileInput.disabled = false;
    if (gpuSelectEl) gpuSelectEl.disabled = false;
    hideLoading();
    setStartButtonMode("ready");
    preAudioCtx?.close().catch(() => {});
    setStatus(error.message, "err");
    showToast(error.message, 6000);
    startBtn?.focus({ preventScroll: true });
    return;
  }

  try { await selectBuildDir(); }
  catch (e) { failRuntime(e.message); return; }

  let gameArg = null;
  const chosenPowerPref = gpuSelectEl?.value || "high-performance";
  log('GPU powerPreference: "' + chosenPowerPref + '"', "info");
  if (preferences.getItem("ppsspp_touch_mouse_fallback") === "1") {
    installTouchMouseShim();
  }

  window.Module = {
    canvas,
    webglContextAttributes: {
      powerPreference: chosenPowerPref,
      alpha: false, antialias: false, depth: true, stencil: true,
      preserveDrawingBuffer: false, desynchronized: true,
      failIfMajorPerformanceCaveat: false,
    },
    SDL2: preAudioCtx ? { audioContext: preAudioCtx } : {},
    arguments: [],
    locateFile(path) {
      let url = BUILD_DIR + path;
      if (path.endsWith(".wasm") || path.endsWith(".worker.js") || path.endsWith(".data")) url += "?v=" + BUILD_STAMP;
      log("locateFile: " + path + " -> " + url);
      return url;
    },
    print(text)    { log("stdout: " + text); },
    printErr(text) {
      updateAudioDebugFromLog(text);
      if (!/WASM audio (push|callback) count=/.test(text)) log("stderr: " + text);
    },
    setStatus(text) {
      if (text) { log("Core startup: " + text, "dim"); setStatus("正在载入模拟器资源…", "run"); }
    },
    monitorRunDependencies(left) {
      log("Run dependencies remaining: " + left);
      if (left > 0) setStatus("正在准备模拟器：" + left + " 项资源待载入", "run");
    },
    preRun: [function () {
      configureEmulatorKeyboard(ENV);
      if (loadNetworkConfig().enabled && !installSockFSAdhocRelay()) throw new Error("Ad Hoc transport unavailable in WASM build");
      log("preRun started.");
      addRunDependency("ppsspp-assets");
      (async () => {
        let prepared = false;
        try {
          await preloadAssets(FS);
          // Restore persisted config and saves from OPFS
          setStatus("正在恢复本机存档…", "run");
          showLoading("正在恢复存档…");
          await loadPersistedFiles(FS);
          await playerSettingsQueue;
          await restorePlayerSettings();
          performanceLaunchSettings = loadPlayerSettings();
          await forceGamesDirectoryConfig(FS);
          gameArg = await preloadGame(FS);
          await preloadStoredGames(FS);
          Module.arguments.length = 0;
          Module.arguments.push(...emulatorLaunchArgs());
          if (gameArg) Module.arguments.push(gameArg);
          log("PPSSPP arguments: " + JSON.stringify(Module.arguments), "info");
          setStatus("正在启动模拟器…", "run");
          showLoading("正在启动模拟器…");
          prepared = true;
        } catch(err) {
          log("preRun failed: " + (err?.stack || err), "err");
          setStatus(err.message || String(err), "err");
          failRuntime("启动失败：" + (err.message || String(err)));
          window.Module?.abort?.(err);
          return;
        } finally {
          log("preRun complete, removing asset dependency.");
          if (prepared) removeRunDependency("ppsspp-assets");
        }
      })();
    }],
    onRuntimeInitialized() {
      clearTimeout(window.ModuleStartupWatchdog);
      if (runtimeFailed) return;
      log("Runtime initialized.", "ok");
      runtimeReady = true;
      updateTouchControls();
      globalThis.PpssppPerformance?.mark("runtimeReady");
      setStatus(gameArg ? "模拟器已启动" : "游戏库已就绪", "ok");
      hideLoading();
      setStartButtonMode("running");
      // Show runtime game loader button
      if (runtimeGameLabel) runtimeGameLabel.style.display = "";
      // Start auto-persist loop (every 30s)
      startAutoPersist();
      updateStorageInfo();
      refreshLibrary();
      setTimeout(() => { if (!runtimeFailed) setStatus(gameArg ? "模拟器已启动" : "游戏库已就绪", "ok"); }, 600);
      setTimeout(describeAudio, 1000);
      setTimeout(() => reconnectKnownGamepadsForSDL("runtime ready", true), 300);
      setTimeout(() => reconnectKnownGamepadsForSDL("runtime settled", true), 1500);
      setInterval(reportAudioStatus, 5000);
      setInterval(updateInfoPanel,   2000);
      // Initial persist after PPSSPP creates its directories
      setTimeout(() => { if (runtimeReady) void persistFiles(window.FS, "init"); }, 8000);
    },
    onAbort(reason) {
      failRuntime("模拟器运行中断：" + reason);
    }
  };

  const script = document.createElement("script");
  script.src   = BUILD_DIR + "PPSSPPSDL.js?v=" + BUILD_STAMP;
  log("Loading script: " + script.src);
  script.onload  = () => {
    log("PPSSPPSDL.js loaded.", "ok");
    if (loadNetworkConfig().enabled && !installSockFSAdhocRelay()) {
      log("Network: SOCKFS relay hook was not available in this build.", "warn");
    }
  };
  script.onerror = () => failRuntime("模拟器文件载入失败，请检查连接后重新载入页面。");
  document.body.appendChild(script);
}

/* ── Touch-to-mouse shim ───────────────────────────────────────── */
// Emergency fallback only. This converts touch to a single mouse pointer, so it
// intentionally disables multitouch and should stay off for normal mobile play.
function installTouchMouseShim() {
  if (installTouchMouseShim.installed) return;
  installTouchMouseShim.installed = true;

  const opts = { capture: true, passive: false };

  // Track the primary (first) active touch id for single-pointer emulation.
  let primaryId = null;

  function isCanvasTouch(e) {
    return e.target === canvas || e.composedPath?.().includes(canvas);
  }

  function toMouse(type, clientX, clientY, buttons) {
    canvas.dispatchEvent(new MouseEvent(type, {
      bubbles: true, cancelable: true,
      clientX, clientY,
      button: 0, buttons,
      movementX: 0, movementY: 0,
    }));
  }

  window.addEventListener('touchstart', (e) => {
    if (!isCanvasTouch(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    for (const t of e.changedTouches) {
      if (primaryId === null) {
        primaryId = t.identifier;
        // Move first so SDL knows the coordinates before the button event.
        toMouse('mousemove', t.clientX, t.clientY, 1);
        toMouse('mousedown', t.clientX, t.clientY, 1);
      }
    }
  }, opts);

  window.addEventListener('touchmove', (e) => {
    if (!isCanvasTouch(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    for (const t of e.changedTouches) {
      if (t.identifier === primaryId) {
        toMouse('mousemove', t.clientX, t.clientY, 1);
        break;
      }
    }
  }, opts);

  window.addEventListener('touchend', (e) => {
    if (!isCanvasTouch(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    for (const t of e.changedTouches) {
      if (t.identifier === primaryId) {
        primaryId = null;
        toMouse('mouseup', t.clientX, t.clientY, 0);
        break;
      }
    }
  }, opts);

  window.addEventListener('touchcancel', (e) => {
    if (!isCanvasTouch(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    for (const t of e.changedTouches) {
      if (t.identifier === primaryId) {
        primaryId = null;
        toMouse('mouseup', t.clientX, t.clientY, 0);
        break;
      }
    }
  }, opts);

  log('Touch-to-mouse shim installed before SDL touch handlers.', 'info');
}

/* ── Event wiring ───────────────────────────────────────────────── */
on(fileInput, "change", () => {
  selectedGame = fileInput?.files?.[0] || null;
  selectedStoredGame = null;
  selectedGameCached = false;
  if (!validateGameSelection(selectedGame)) {
    if (idleSubtitle) idleSubtitle.textContent = gameFileValidationError(selectedGame);
    return;
  }
  if (fileLabel) fileLabel.title = selectedGame ? selectedGame.name : "选择游戏文件";
  // Update the visible text node inside the label
  const textNode = fileLabel?.firstChild;
  if (textNode && textNode.nodeType === 3)
    textNode.textContent = (selectedGame ? "\uD83D\uDCC2 " + selectedGame.name : "📂 选择游戏文件") + " ";
  updateIdleOverlay();
  setStatus(selectedGame ? "已选择：" + selectedGame.name : "请选择本机游戏文件，或打开游戏库。");
});

on(startBtn, "click", () => {
  start();
});
on(idleStartBtn, "click", start);

on("refreshLibraryBtn", "click", refreshLibrary);
on("libraryGrid", "click", e => {
  const button = e.target.closest("button[data-action]");
  if (!button) return;
  const name = button.dataset.game;
  if (!name) return;
  if (button.dataset.action === "play") playOrMountStoredGame(name);
  else if (button.dataset.action === "favorite") togglePreloadFavorite(name);
  else if (button.dataset.action === "info") showGameInfo(name);
  else if (button.dataset.action === "drive-upload") runDriveAction("upload-game", () => uploadSingleGameToDrive(name));
  else if (button.dataset.action === "delete") deleteStoredFile(VIRTUAL_GAME_DIR + "/" + name);
});
on("libraryImportFile", "change", e => {
  const f = e.target.files[0]; if (!f) return;
  e.target.value = "";
  addGameToLibrary(f);
});
on("libraryDownloadUrlBtn", "click", () => {
  addGameURLToLibrary(byId("libraryUrlInput")?.value || "");
});
on("libraryUrlInput", "keydown", e => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  addGameURLToLibrary(e.currentTarget.value);
});
on("gameInfoCloseBtn", "click", closeGameInfo);
on("gameInfoModal", "click", e => {
  if (e.target.id === "gameInfoModal") closeGameInfo();
});

// ── Runtime game loading ─────────────────────────────────────────
runtimeGameInput?.addEventListener("change", e => {
  const f = e.target.files[0]; if (!f) return;
  e.target.value = "";
  loadGameAtRuntime(f);
});

// ── Saves tab buttons ─────────────────────────────────────────────
on("refreshSavesBtn", "click", refreshSavesTab);
on("exportAllSavesBtn", "click", exportSaves);
on("savesList", "click", async e => {
  const button = e.target.closest("button[data-save-action]");
  if (!button) return;
  const action = button.dataset.saveAction;
  try {
    if (action === "download-slot") {
      await downloadSaveSlot(button.dataset.slotDir, button.dataset.game);
    } else if (action === "drive-upload-slot") {
      await runDriveAction("upload-slot", () => uploadSingleSaveSlotToDrive(button.dataset.slotDir, button.dataset.game));
    } else if (action === "delete-slot") {
      await deleteSaveSlot(button.dataset.slotDir, button.dataset.game);
    } else if (action === "download-file") {
      await downloadSaveFile(button.dataset.path);
    } else if (action === "drive-upload-state") {
      await runDriveAction("upload-state", () => uploadSingleSaveStateToDrive(JSON.parse(button.dataset.paths || "[]"), button.dataset.game));
    } else if (action === "delete-pair") {
      await deleteSavePair(JSON.parse(button.dataset.paths || "[]"));
    }
  } catch(err) {
    showToast("操作未完成：" + (err?.message || err));
    log("Save action failed: " + (err?.message || err), "err");
  }
});
on("importSaveSlotFile", "change", e => {
  const f = e.target.files[0]; if (!f) return;
  importSaveSlot(f); e.target.value = "";
});
on("deleteAllSavesBtn", "click", async () => {
  if (!confirm("删除全部游戏存档和即时存档吗？\n删除后无法撤销，请先导出备份。")) return;
  // Delete only save-related OPFS entries (not config files or games)
  const all = await opfsWalk();
  for (const { path } of all) {
    const isSave = SAVE_SUBDIRS.some(sub => path.includes("/" + sub.dir + "/"));
    if (!isSave) continue;
    try { await opfsDelete(path); } catch(e) {}
  }
  // Also wipe from live FS if running
  const FS = window.FS;
  if (FS) {
    const memstick = _detectedMemstick || detectMemstickDir(FS);
    for (const { dir, flat } of SAVE_SUBDIRS) {
      const base = memstick + "/" + dir;
      if (flat) {
        // flat: delete all files in the dir
        let entries; try { entries = FS.readdir(base).filter(n=>n!=="."&&n!==".."); } catch(e){ entries=[]; }
        for (const name of entries) { try { FS.unlink(base + "/" + name); } catch(e){} }
      } else {
        let games; try { games = FS.readdir(base).filter(n=>n!=="."&&n!==".."); } catch(e){ games=[]; }
        for (const g of games) {
          const slotDir = base + "/" + g;
          const files = readSaveSlotFiles(FS, slotDir);
          for (const {path} of files) { try { FS.unlink(path); } catch(e){} }
          try { FS.rmdir(slotDir); } catch(e){}
        }
      }
    }
  }
  showToast("全部存档已删除");
  refreshSavesTab(); updateStorageInfo();
});

// ── Storage panel buttons ────────────────────────────────────────
on("syncNowBtn", "click", syncPlayerFiles);
on("player-save-files", "click", syncPlayerFiles);
on("player-pause-game", "click", openCoreMenu);
on("player-resume-game", "click", returnToGameCanvas);
for (const id of ["player-render-resolution", "player-show-fps", "player-touch-controls"]) {
  on(id, "change", savePlayerSettings);
}

on("exportSavesBtn", "click", exportSaves);

on("importSavesFile", "change", e => {
  const f = e.target.files[0]; if (!f) return;
  e.target.value = "";
  importSaves(f);
});

// ── Google Drive buttons ─────────────────────────────────────────
if (!LOCAL_ONLY) {
  initDriveConfigUI();
  restartDriveAutoSyncTimer();
  if (handleGoogleRedirectCallback()) activatePanelTab("drive");
}
window.addEventListener("storage", e => {
  if (LOCAL_ONLY) return;
  if (e.key !== GOOGLE_TOKEN_KEY) return;
  if (restoreGoogleToken()) {
    setDriveActivity("Google connected. Reading Drive…", "run");
    restartDriveAutoSyncTimer();
    refreshDriveList().catch(err => {
      const message = googleAuthErrorMessage(err);
      log("Google Drive refresh failed after cross-tab login: " + message, "err");
      setDriveActivity("Refresh failed: " + message, "bad");
    });
  } else {
    disconnectGoogleDrive();
  }
});
on("saveGoogleClientIdBtn", "click", () => {
  const value = (googleClientIdInput?.value || "").trim();
  if (value) preferences.setItem(GOOGLE_CLIENT_ID_KEY, value);
  else preferences.removeItem(GOOGLE_CLIENT_ID_KEY);
  setGoogleToken("", 0);
  takePendingDriveAction();
  googleTokenClient = null;
  setDriveInfo(value ? "Client ID saved" : "Client ID cleared", value ? "good" : "");
  showToast(value ? "Google client ID saved" : "Google client ID cleared");
});
on("toggleGoogleClientIdBtn", "click", () => {
  if (!googleClientIdInput) return;
  const visible = googleClientIdInput.type === "text";
  googleClientIdInput.type = visible ? "password" : "text";
  const button = byId("toggleGoogleClientIdBtn");
  if (button) {
    button.title = visible ? "Show client ID" : "Hide client ID";
    button.textContent = visible ? "\uD83D\uDC41" : "\u25CF";
  }
});
on("driveConnectBtn", "click", connectGoogleDrive);
on("driveDisconnectBtn", "click", disconnectGoogleDrive);
on("driveRefreshBtn", "click", async () => {
  try { await runDriveAction("refresh", refreshDriveList); showToast("✓ Drive refreshed"); }
  catch(e) {
    const message = googleAuthErrorMessage(e);
    log("Google Drive refresh failed: " + message, "err");
    setDriveActivity("Refresh failed: " + message, "bad");
    showToast("操作未完成：" + message, 5000);
  }
});
on("driveUploadSavesBtn", "click", () => runDriveAction("upload-saves", uploadSavesToDrive));
on("driveRestoreSavesBtn", "click", () => runDriveAction("restore-saves", () => restoreDriveSave()));
on("driveUploadGamesBtn", "click", () => runDriveAction("upload-games", uploadGamesToDrive));
on("driveDownloadGamesBtn", "click", () => runDriveAction("download-games", downloadAllDriveGames));

// Drive auto-sync controls
on("driveAutoSyncToggle", "change", e => {
  preferences.setItem(GOOGLE_AUTO_SYNC_KEY, e.target.checked ? "1" : "0");
  restartDriveAutoSyncTimer();
  showToast(e.target.checked ? "✓ Drive auto-sync enabled" : "Drive auto-sync disabled");
});
on("driveAutoSyncInterval", "change", e => {
  preferences.setItem(GOOGLE_AUTO_SYNC_RATE_KEY, e.target.value);
  restartDriveAutoSyncTimer();
});

// Drive badge → navigate to Drive tab
driveBadgeEl?.addEventListener("click", () => activatePanelTab("drive"));
driveBadgeEl?.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") activatePanelTab("drive"); });

driveRemoteList?.addEventListener("click", e => {
  const button = e.target.closest("button[data-drive-action]");
  if (!button) return;
  const id = button.dataset.id;
  if (button.dataset.driveAction === "restore-save") {
    const file = googleDriveRemoteCache.saves.find(f => f.id === id);
    if (file) restoreDriveSave(file);
  } else if (button.dataset.driveAction === "download-game") {
    const file = googleDriveRemoteCache.games.find(f => f.id === id);
    if (file) downloadDriveGame(file);
  }
});

on("clearStorageBtn", "click", async () => {
  if (!confirm("清除本机的全部存档、设置和游戏缓存吗？删除后无法撤销，请先导出存档备份。")) return;
  try {
    await opfsClearAll();
    _lastPersistTime = 0;
    refreshLibrary();
    updateStorageInfo();
    log("OPFS storage cleared.", "warn");
    showToast("本机存储已清空");
  } catch (error) { showToast("清理未完成：" + error.message, 6500); }
});

window.addEventListener("pointerdown", () => { if (started) unlockAudio(); });
window.addEventListener("keydown",      () => { if (started) unlockAudio(); });
// Re-resume AudioContext when the tab becomes visible again (Chrome suspends on tab-switch)
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && started) unlockAudio();
});
// Also resume on any focus event (covers tab-switching, alt-tab, etc.)
window.addEventListener("focus", () => { if (started) unlockAudio(); });

// ── Fullscreen + cursor auto-hide ─────────────────────────────────
let _fsCursorTimer = null;
function _hideCursor() { document.body.classList.add("fs-cursor-hidden"); }
function _showCursor() {
  document.body.classList.remove("fs-cursor-hidden");
  clearTimeout(_fsCursorTimer);
  if (fullscreenElement()) _fsCursorTimer = setTimeout(_hideCursor, 2000);
}

function isFullscreenActive() {
  return !!fullscreenElement();
}

function fullscreenTarget() {
  return document.querySelector(".body-main") || stageEl || canvas || document.documentElement;
}

let fullscreenOrientationSession = null;

function unlockFullscreenOrientation(session) {
  if (!session.requested) return;
  try { session.orientation.unlock?.(); }
  catch (error) { log("Screen orientation unlock failed: " + (error?.message || error), "warn"); }
}

function releaseFullscreenOrientation() {
  const session = fullscreenOrientationSession;
  fullscreenOrientationSession = null;
  if (session) unlockFullscreenOrientation(session);
}

function syncFullscreenOrientation() {
  const target = fullscreenElement();
  // Touch-capable desktop computers should keep their normal display orientation.
  if (!isMobileExperience() || document.hidden || !target?.contains(canvas)) {
    releaseFullscreenOrientation();
    return Promise.resolve(false);
  }
  if (fullscreenOrientationSession?.target === target) return fullscreenOrientationSession.promise;
  releaseFullscreenOrientation();
  const orientation = window.screen?.orientation;
  const session = { target, orientation, requested: false, promise: Promise.resolve(false) };
  fullscreenOrientationSession = session;
  if (typeof orientation?.lock !== "function") {
    showToast("当前浏览器不支持锁定横屏，请手动旋转手机；全屏游玩仍可使用。", 6500);
    return session.promise;
  }
  session.requested = true;
  // Keep one attempt per fullscreen session. A failed request must not create a retry loop.
  session.promise = (async () => {
    try {
      await orientation.lock("landscape");
      if (fullscreenOrientationSession !== session || fullscreenElement() !== target || document.hidden) {
        // A late completion after exit must not undo a newer fullscreen session's lock.
        if (!fullscreenOrientationSession) unlockFullscreenOrientation(session);
        return false;
      }
      scheduleRuntimeResize(true);
      return true;
    } catch (error) {
      if (fullscreenOrientationSession === session && fullscreenElement() === target && !document.hidden) {
        log("Screen orientation lock failed: " + (error?.name || "Error") + ": " + (error?.message || error), "warn");
        showToast("浏览器未允许锁定横屏，请手动旋转手机，并检查系统自动旋转设置。", 6500);
      }
      return false;
    }
  })();
  return session.promise;
}

// SDL may request fullscreen directly on the canvas. Keep the shell controls
// and panels inside the fullscreen element in that path too.
for (const method of ["requestFullscreen", "webkitRequestFullscreen"]) {
  if (!canvas || typeof canvas[method] !== "function") continue;
  const nativeRequest = canvas[method].bind(canvas);
  canvas[method] = (...args) => {
    const target = fullscreenTarget();
    return target !== canvas && typeof target[method] === "function" ? target[method](...args) : nativeRequest(...args);
  };
}

async function requestBrowserFullscreen() {
  const target = fullscreenTarget();
  if (!target) return false;

  try {
    if (target.requestFullscreen) {
      await target.requestFullscreen({ navigationUI: "hide" });
      return true;
    }
    if (target.webkitRequestFullscreen) {
      target.webkitRequestFullscreen();
      return true;
    }
  } catch(e) {
    log("Browser fullscreen request failed: " + (e?.message || e), "warn");
  }
  return false;
}

async function exitBrowserFullscreen() {
  try {
    if (document.exitFullscreen) {
      await document.exitFullscreen();
      return true;
    }
    if (document.webkitExitFullscreen) {
      document.webkitExitFullscreen();
      return true;
    }
  } catch(e) {
    log("Browser fullscreen exit failed: " + (e?.message || e), "warn");
  }
  return false;
}

function handleFullscreenChange() {
  setFullscreenMenuOpen(false, false);
  syncFullscreenOverlays();
  scheduleRuntimeResize(true);
  void syncFullscreenOrientation();
  if (fullscreenElement()) {
    _fsCursorTimer = setTimeout(_hideCursor, 2000);
    document.addEventListener("mousemove", _showCursor);
    document.addEventListener("pointerdown", _showCursor);
  } else {
    clearTimeout(_fsCursorTimer);
    document.body.classList.remove("fs-cursor-hidden");
    document.removeEventListener("mousemove", _showCursor);
    document.removeEventListener("pointerdown", _showCursor);
  }
}

document.addEventListener("fullscreenchange", handleFullscreenChange);
document.addEventListener("webkitfullscreenchange", handleFullscreenChange);
document.addEventListener("visibilitychange", () => { void syncFullscreenOrientation(); });
window.addEventListener("pagehide", releaseFullscreenOrientation);
window.addEventListener("pageshow", () => { void syncFullscreenOrientation(); });

async function togglePPSSPPFullscreen() {
  if (isFullscreenActive()) {
    if (await exitBrowserFullscreen()) {
      scheduleRuntimeResize(true);
      return;
    }
  }

  if (await requestBrowserFullscreen()) {
    scheduleRuntimeResize(true);
    return;
  }

  if (isMobileExperience()) {
    showToast("浏览器暂不允许网页全屏，无法锁定横屏；请手动旋转手机，或点击全屏按钮重试。", 6500);
    return;
  }

  const toggleFullscreen = window.Module?._PPSSPP_ToggleFullscreen;
  if (typeof toggleFullscreen !== "function") {
    log("Fullscreen toggle requested before PPSSPP runtime is ready.", "warn");
    showToast("浏览器暂不允许全屏，请直接点击全屏按钮重试。");
    return;
  }
  toggleFullscreen();
  scheduleRuntimeResize(true);
}

on(fullscreenBtn, "click", async () => {
  await togglePPSSPPFullscreen();
  canvas?.focus();
  describeAudio();
});
function setFullscreenMenuOpen(open, focus = true) {
  const toggle = byId("fsMenuToggle");
  toggle?.setAttribute("aria-expanded", String(open));
  for (const id of ["fsMenuActions", "fsMenuBackdrop"]) {
    const element = byId(id);
    if (element) element.hidden = !open;
  }
  if (focus) (open ? byId("fsPanelBtn") : toggle)?.focus({ preventScroll: true });
  updateTouchControls();
}
on("fsMenuToggle", "click", () => setFullscreenMenuOpen(byId("fsMenuToggle")?.getAttribute("aria-expanded") !== "true"));
on("fsMenuBackdrop", "click", () => setFullscreenMenuOpen(false));
document.addEventListener("keydown", event => {
  const panelOpen = document.body.classList.contains("panel-open");
  const menuOpen = byId("fsMenuToggle")?.getAttribute("aria-expanded") === "true";
  if (!panelOpen && !menuOpen) return;
  if (event.key === "Escape") {
    event.preventDefault(); event.stopImmediatePropagation();
    if (panelOpen) setPanelOpen(false); else setFullscreenMenuOpen(false);
  } else if (event.key === "Tab") {
    const container = byId(panelOpen ? "sidePanel" : "fsMenuActions");
    const controls = [...(container?.querySelectorAll('button, input, select, textarea, a[href], [tabindex="0"]') || [])]
      .filter(element => !element.disabled && element.getClientRects().length);
    const first = controls[0], last = controls[controls.length - 1];
    if (first && (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
      event.preventDefault(); (event.shiftKey ? last : first).focus({ preventScroll: true });
    }
  }
}, true);
on("fsPanelBtn", "click", () => setPanelOpen(!document.body.classList.contains("panel-open")));
on("fsExitBtn", "click", async () => {
  setFullscreenMenuOpen(false, false);
  await exitBrowserFullscreen();
  fullscreenBtn?.focus();
});

/* ── Init ───────────────────────────────────────────────────────── */
syncFullscreenOverlays();
log("Page loaded. crossOriginIsolated=" + window.crossOriginIsolated, window.crossOriginIsolated ? "ok" : "warn");
log("Build: " + BUILD_STAMP, "dim");
probeWebGLFeatures();
initializePerformancePanel();
updateInfoPanel();
refreshLibrary();
updateStorageInfo();    // populate OPFS tab with stats on load
refreshSavesTab();      // populate Saves tab from OPFS on load (no FS needed)
refreshPlayerSettingsUI();
void restorePlayerSettings();

import('./online-games.js').then(({ initOnlineGames }) => initOnlineGames({
  canPlay: () => !started,
  reportError: message => showToast(message, 6500),
  play(file) {
    if (started || !validateGameSelection(file)) return;
    selectedGame = file;
    selectedStoredGame = null;
    selectedGameCached = true;
    updateIdleOverlay();
    setPanelOpen(false);
    start();
  },
})).catch(error => {
  const status = byId('onlineManifestStatus');
  if (status) status.textContent = '在线下载组件加载失败，请刷新页面重试。';
  log('Download UI load failed: ' + error.message, 'warn');
});

/* ── PWA: Service Worker registration ──────────────────────────── */
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("controllerchange", () => reloadForCrossOriginIsolation("controllerchange"));
  navigator.serviceWorker.register("sw.js", { scope: "./" })
    .then(reg => {
      log("SW registered (scope: " + reg.scope + ")", "ok");
      if (navigator.serviceWorker.controller && !window.crossOriginIsolated) {
        reloadForCrossOriginIsolation("existing controller");
      }
      reg.addEventListener("updatefound", () => {
        const sw = reg.installing;
        sw?.addEventListener("statechange", () => {
          if (sw.state === "installed" && navigator.serviceWorker.controller) {
            showToast("发现新版本。请先在游戏内存档并同步到本机，再重新载入页面。", 6000);
          }
        });
      });
    })
    .catch(err => log("SW registration failed: " + err.message, "warn"));
}
