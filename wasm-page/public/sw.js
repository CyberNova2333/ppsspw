// SPDX-License-Identifier: GPL-2.0-or-later
// Derived from upstream root-hunter/ppsspp-web (GPL-2.0-or-later; see LICENSE.TXT and UPSTREAM.md), with modifications by CyberNova for PPSSPW (combined with PPSSPW AGPL-3.0-only modules under GPLv3/AGPLv3 Section 13).
/**
 * PPSSPW – Service Worker
 *
 * Strategy:
 *  - App shell (index.html, manifest, sw itself) → Network-first with cache fallback
 *  - WASM / JS / asset files                     → Cache-first (immutable builds)
 *  - Everything else                              → Network-only (pass-through)
 *
 * The cache is versioned; old player caches are pruned after a complete replacement is available.
 */

const CACHE_VERSION = "ppsspp-player-v22";

// Replaced by the packager with paths from this Angular build.
const BUILD_SHELL = {"files":[],"digest":""};
const VERSIONED_SCRIPTS = ["performance", "browser-storage", "browser-files", "adhoc-transport", "touch-controls", "pad-presets", "frameflow-bridge", "save-worker", "ppsspp-runtime"];
const SHELL_FILES = [...new Set(["./", "./index.html", "./manifest.webmanifest", "./day-night-switch.js",
  ...VERSIONED_SCRIPTS.map(name => "./" + name + ".js?v=" + CACHE_VERSION), ...BUILD_SHELL.files])];

// Extensions considered immutable build artifacts → cache-first
const IMMUTABLE_EXTS = /\.(wasm|js|data|mem|zim|meta|png|svg|ico|webp|json|bin|txt|css|woff2)$/i;

// ── Install ──────────────────────────────────────────────────────────────────
self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await openCache();
    if (!cache && self.registration.active) throw new Error("Offline shell cache unavailable");
    if (cache) {
      const requests = paths => paths.map(path => new Request(new URL(path, self.registration.scope), { cache: "reload" }));
      const optional = path => /\.(?:png|svg|ico|webp|woff2)$/i.test(path);
      const critical = requests(SHELL_FILES.filter(path => !optional(path)));
      try { await cache.addAll(critical); }
      catch (error) {
        if (self.registration.active || !["QuotaExceededError", "SecurityError"].includes(error.name)) {
          await cache.addAll(critical);
        }
      }
      await Promise.allSettled(requests(SHELL_FILES.filter(optional)).map(request => cache.add(request)));
    }
    await self.skipWaiting();
  })());
});

// ── Activate  ────────────────────────────────────────────────────────────────
self.addEventListener("activate", event => {
  event.waitUntil(self.clients.claim().then(() => scheduleCollection()));
});

// Only prune once the published core is complete. Ask every open player,
// including clients of the previous worker. An unresponsive client defers GC.
const coreFile = /\/build-wasm\/PPSSPPSDL\.(js|wasm|data|worker\.js)\?v=([a-f0-9]{64})$/;
const cacheGeneration = name => /^ppsspp-player-v\d+$/.test(name) ? Number(name.split("-v").pop()) : -1;
async function olderPlayerCaches() {
  const generation = cacheGeneration(CACHE_VERSION);
  return (await caches.keys())
    .filter(name => { const v = cacheGeneration(name); return v >= 0 && v < generation; })
    .sort((a, b) => cacheGeneration(b) - cacheGeneration(a));
}
const completeCore = files => ["js", "wasm", "data"].every(name => files?.has(name));
async function coreGroups(cache) {
  const groups = new Map();
  const prefix = new URL("build-wasm/PPSSPPSDL.", self.registration.scope).href;
  for (const request of await cache.keys()) {
    if (!request.url.startsWith(prefix)) continue;
    const match = request.url.match(coreFile);
    if (!match) continue;
    if (!groups.has(match[2])) groups.set(match[2], new Map());
    groups.get(match[2]).set(match[1], request);
  }
  return groups;
}

function playerEntry(url) {
  const entry = new URL(url);
  entry.search = "";
  entry.hash = "";
  const scope = self.registration.scope;
  return entry.href === scope || entry.href === new URL("index.html", scope).href;
}

async function collectCoreRevisions() {
  const cache = await openCache();
  if (!cache) return;
  const groups = await coreGroups(cache);
  const older = await olderPlayerCaches();
  if (groups.size < 2 && !older.length) return;
  const manifest = new URL("build-info.json", self.registration.scope);
  let info;
  try { info = await fetch(manifest, { cache: "no-store" }); } catch (_) {}
  if (!info?.ok) info = await cache.match(manifest);
  if (!info?.ok) return;
  const { revision } = await info.clone().json();
  if (!/^[a-f0-9]{64}$/.test(revision)) return;
  const keep = new Set([revision]);
  if (completeCore(groups.get(revision))) {
    await cache.put(manifest, info);
  } else {
    // Repeated interrupted upgrades must not pin every partial download.
    // Keep the current download plus the newest complete offline fallback.
    const fallback = [...groups].reverse().find(([, files]) => completeCore(files));
    if (fallback) keep.add(fallback[0]);
  }
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const active = await Promise.all(clients.filter(c => playerEntry(c.url)).map(client => new Promise(resolve => {
    const channel = new MessageChannel();
    const done = value => { clearTimeout(timer); channel.port1.close(); resolve(value); };
    const timer = setTimeout(() => done(null), 1000);
    channel.port1.onmessage = event => done(event.data);
    client.postMessage(older.length ? "query-player-cache" : "query-core-revision", [channel.port2]);
  })));
  if (active.includes(null)) return;
  const activeCores = new Set(active.map(reply => reply.revision ?? reply));
  for (const [key, files] of groups) {
    if (!keep.has(key) && !activeCores.has(key)) await Promise.all([...files.values()].map(request => cache.delete(request)));
  }
  if (!completeCore(groups.get(revision))) return;
  for (const name of older) {
    if (active.some(reply => reply.cache === name)) continue;
    const previous = await caches.open(name);
    const requests = await previous.keys();
    // Cache Storage is origin-wide. A different player installation may share this name.
    const scope = self.registration.scope;
    if (requests.some(r => !r.url.startsWith(scope) || (/\/(?:index\.html)?$/.test(new URL(r.url).pathname) && !playerEntry(r.url)))) continue;
    const oldCores = await coreGroups(previous);
    if ([...activeCores].some(rev => oldCores.has(rev) && !completeCore(groups.get(rev)))) continue;
    await caches.delete(name);
  }
}

let scheduledCollection, collectionRequested;
function scheduleCollection() {
  // Coalesce concurrent cache writes and allow a closing tab to leave.
  collectionRequested = true;
  return scheduledCollection ??= (async () => {
    try {
      while (collectionRequested) {
        await new Promise(resolve => setTimeout(resolve, 250));
        collectionRequested = false;
        await collectCoreRevisions();
      }
    } catch (_) { /* Cache access may be unavailable. Retry on the next event. */ }
    finally { scheduledCollection = null; }
  })();
}
self.addEventListener("message", event => {
  if (event.data === "collect-core-revisions") event.waitUntil(scheduleCollection());
});

// ── Fetch ────────────────────────────────────────────────────────────────────
self.addEventListener("fetch", event => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle same-origin GET requests
  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  const pathname = url.pathname;

  // Range responses and user-provided manifests must never enter the shell cache.
  // A cached 206 or stale manifest could otherwise corrupt resumed downloads.
  if (request.headers.has('Range') || request.cache === 'no-store') return;

  // App shell → network-first, fallback to cache
  const isShell = pathname.endsWith("/") ||
                  pathname.endsWith("/index.html") ||
                  pathname.endsWith("/manifest.webmanifest") ||
                  pathname.endsWith("/ppsspp-runtime.js") ||
                  pathname.endsWith("/frameflow-bridge.js") ||
                  (pathname.includes("/frameflow/") && pathname.endsWith(".js")) ||
                  pathname.endsWith("/touch-controls.js") ||
                  pathname.endsWith("/pad-presets.js") ||
                  pathname.endsWith("/performance.js") ||
                  pathname.endsWith("/browser-files.js") ||
                  pathname.endsWith("/browser-storage.js") ||
                  pathname.endsWith("/online-games.js") ||
                  pathname.endsWith("/game-download.js") ||
                  pathname.endsWith("/download-worker.js") ||
                  pathname.endsWith("/save-worker.js") ||
                  pathname.endsWith("/build-info.json") ||
                  pathname.endsWith("/assets-manifest.txt");

  if (isShell) {
    event.respondWith(networkFirst(request, event));
    return;
  }

  // Immutable build artifacts → cache-first
  if (IMMUTABLE_EXTS.test(pathname)) {
    event.respondWith(cacheFirst(request, event));
    return;
  }

  // Everything else (serve.py API, etc.) → network only
});

// ── Strategies ───────────────────────────────────────────────────────────────

async function openCache() {
  try { return await caches.open(CACHE_VERSION); } catch (_) { return null; }
}

async function cachedResponse(cache, request) {
  try { return await cache?.match(request); } catch (_) { return null; }
}

async function previousResponse(request, navigation = false) {
  try {
    for (const name of await olderPlayerCaches()) {
      const previous = await caches.open(name);
      if (navigation && ![...(await coreGroups(previous)).values()].some(completeCore)) continue;
      const response = await previous.match(request, { ignoreSearch: navigation });
      if (response) return response;
    }
  } catch (_) { /* Storage can be disabled. */ }
  return null;
}

async function networkFirst(request, event) {
  const cache = await openCache();
  try {
    const response = withCrossOriginIsolation(await fetch(request));
    if (response.ok && cache) {
      const write = cache.put(request, response.clone()).catch(() => {});
      event?.waitUntil(write);
    }
    return response;
  } catch (_) {
    let cached;
    if (request.mode === "navigate" && playerEntry(request.url) && cache &&
        ![...(await coreGroups(cache)).values()].some(completeCore)) {
      cached = await previousResponse(request, true);
    }
    cached ??= await cachedResponse(cache, request) || await previousResponse(request);
    return cached ? withCrossOriginIsolation(cached) : withCrossOriginIsolation(new Response("当前离线，尚未缓存此页面。请连接网络后重试。", {
      status: 503,
      headers: { "Content-Type": "text/plain" },
    }));
  }
}

async function cacheFirst(request, event) {
  const cache = await openCache();
  const cached = await cachedResponse(cache, request);
  if (cached) return withCrossOriginIsolation(cached);
  try {
    const previous = coreFile.test(request.url) && await previousResponse(request);
    const response = withCrossOriginIsolation(previous || await fetch(request));
    if (response.ok && cache) {
      const write = cache.put(request, response.clone()).then(() => coreFile.test(request.url) && scheduleCollection()).catch(() => {});
      event?.waitUntil(write);
    }
    return response;
  } catch (err) {
    const previous = await previousResponse(request);
    if (previous) return withCrossOriginIsolation(previous);
    return withCrossOriginIsolation(new Response("网络连接失败：" + err.message, {
      status: 503,
      headers: { "Content-Type": "text/plain" },
    }));
  }
}

function withCrossOriginIsolation(response) {
  if (!response || response.type === "opaque") return response;

  const headers = new Headers(response.headers);
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
