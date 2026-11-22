// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of PPSSPW and is licensed under GNU AGPLv3 with Additional Terms (see LICENSE and LICENSE-ADDITIONAL_TERMS-zh-CN.md; ref: LICENSE-ADDITIONAL_TERMS-en.md).
/* Off-main-thread atomic staged OPFS save commits using SyncAccessHandle + move(). */
"use strict";

const encoder = new TextEncoder();

function pathParts(path) {
  if (typeof path !== "string" || path.includes("\\")) throw new Error("存档路径无效");
  const parts = path.split("/").filter(Boolean);
  if (!parts.length || parts.some(part => part === "." || part === "..")) throw new Error("存档路径无效");
  return parts;
}

async function ensureDir(root, parts, create, cache) {
  const key = (create ? "1:" : "0:") + parts.join("/");
  if (cache?.has(key)) return cache.get(key);
  let dir = root;
  for (const part of parts) dir = await dir.getDirectoryHandle(part, { create });
  if (cache) {
    cache.set(key, dir);
    if (create) cache.set("0:" + parts.join("/"), dir);
  }
  return dir;
}

async function writeSync(handle, data) {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  if (typeof handle.createSyncAccessHandle !== "function") {
    throw Object.assign(new DOMException("SyncAccessHandle unavailable", "NotSupportedError"), { fallback: true });
  }
  const sync = await handle.createSyncAccessHandle();
  try {
    sync.truncate(0);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const written = sync.write(bytes.subarray(offset), { at: offset });
      if (!written) throw new Error("OPFS sync write made no progress");
      offset += written;
    }
    sync.flush();
  } finally {
    sync.close();
  }
  return bytes.byteLength;
}

function collectTransferBuffers(entries) {
  const seen = new Set();
  const list = [];
  for (const entry of entries || []) {
    const bytes = entry?.bytes;
    if (!bytes || !bytes.buffer) continue;
    if (typeof SharedArrayBuffer !== "undefined" && bytes.buffer instanceof SharedArrayBuffer) continue;
    if (bytes.byteOffset !== 0 || bytes.byteLength !== bytes.buffer.byteLength) continue;
    if (seen.has(bytes.buffer)) continue;
    seen.add(bytes.buffer);
    list.push(bytes.buffer);
  }
  return list;
}

async function removeEntryQuiet(dir, name, recursive = false) {
  try { await dir.removeEntry(name, recursive ? { recursive: true } : undefined); }
  catch (error) { if (error?.name !== "NotFoundError") throw error; }
}

async function stageEntries(appRoot, playerDir, persistDir, entries, dirCache) {
  const t0 = performance.now();
  if (typeof FileSystemFileHandle === "undefined" ||
      typeof FileSystemFileHandle.prototype?.move !== "function" ||
      typeof FileSystemFileHandle.prototype?.createSyncAccessHandle !== "function") {
    throw Object.assign(new DOMException("OPFS staged commit APIs unavailable", "NotSupportedError"), { fallback: true });
  }
  const stageDir = await playerDir.getDirectoryHandle("import-stage", { create: true });
  const manifestFiles = [];
  let stagedBytes = 0;
  let writingPath = null;
  try {
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      writingPath = entry.path;
      const parts = pathParts(entry.path);
      parts.pop();
      if (entry.bytes !== null) {
        const handle = await stageDir.getFileHandle(String(i), { create: true });
        stagedBytes += await writeSync(handle, entry.bytes);
        await ensureDir(appRoot, [persistDir, ...parts], true, dirCache);
        manifestFiles.push({ path: entry.path, hasBytes: true });
      } else {
        manifestFiles.push({ path: entry.path, hasBytes: false });
      }
    }
    return { stageDir, manifestFiles, stagedBytes, stageMs: performance.now() - t0 };
  } catch (error) {
    if (writingPath) error.saveFilePath = writingPath;
    try { await removeEntryQuiet(playerDir, "import-stage", true); } catch (_) {}
    throw error;
  }
}

async function publishStaged(appRoot, playerDir, persistDir, manifestFiles, revisions, dirCache) {
  const t0 = performance.now();
  const stageDir = await playerDir.getDirectoryHandle("import-stage", { create: false });
  const pendingPayload = JSON.stringify({ mode: "stage", files: manifestFiles, revisions });
  const pendingTmp = await stageDir.getFileHandle("pending.tmp", { create: true });
  if (typeof pendingTmp.move !== "function") {
    throw Object.assign(new DOMException("FileSystemFileHandle.move unavailable", "NotSupportedError"), { fallback: true });
  }
  let metaBytes = await writeSync(pendingTmp, pendingPayload);
  // Single rename makes pending.json the atomic commit point; readers either
  // discard an unmarked directory or roll forward a complete manifest.
  await pendingTmp.move(stageDir, "pending.json");
  let committed = true;
  let movedFiles = 0;
  try {
    for (let i = 0; i < manifestFiles.length; i++) {
      const item = manifestFiles[i];
      const parts = pathParts(item.path);
      const name = parts.pop();
      if (item.hasBytes) {
        const targetDir = await ensureDir(appRoot, [persistDir, ...parts], true, dirCache);
        const stagedHandle = await stageDir.getFileHandle(String(i));
        await stagedHandle.move(targetDir, name);
        movedFiles++;
      } else {
        try {
          const targetDir = await ensureDir(appRoot, [persistDir, ...parts], false, dirCache);
          await targetDir.removeEntry(name);
        } catch (error) {
          if (error?.name !== "NotFoundError") throw error;
        }
      }
    }
    if (revisions !== null) {
      const revTmp = await playerDir.getFileHandle("save-revisions.tmp", { create: true });
      metaBytes += await writeSync(revTmp, JSON.stringify(revisions));
      await revTmp.move(playerDir, "save-revisions.json");
    }
    await stageDir.removeEntry("pending.json");
  } catch (error) {
    error.committed = committed;
    throw error;
  }
  try { await removeEntryQuiet(playerDir, "import-stage", true); } catch (_) {}
  return { publishMs: performance.now() - t0, movedFiles, metaBytes };
}

self.onmessage = async (event) => {
  const msg = event.data;
  const { id, type, rootDir, persistDir, entries, files, revisions } = msg;
  if (type === "ping") {
    const supported = typeof navigator?.storage?.getDirectory === "function" &&
      typeof FileSystemFileHandle !== "undefined" &&
      typeof FileSystemFileHandle.prototype?.move === "function" &&
      typeof FileSystemFileHandle.prototype?.createSyncAccessHandle === "function";
    self.postMessage({ id, ok: true, supported });
    return;
  }
  let playerDir = null;
  try {
    const origin = await navigator.storage.getDirectory();
    const appRoot = await origin.getDirectoryHandle(rootDir, { create: true });
    playerDir = await appRoot.getDirectoryHandle("player", { create: true });

    if (type === "abort-stage") {
      await removeEntryQuiet(playerDir, "import-stage", true);
      self.postMessage({ id, ok: true });
      return;
    }

    const dirCache = new Map();
    if (type === "stage") {
      const staged = await stageEntries(appRoot, playerDir, persistDir, entries, dirCache);
      self.postMessage({
        id, ok: true,
        files: staged.manifestFiles,
        stagedBytes: staged.stagedBytes,
        stageMs: staged.stageMs,
      });
      return;
    }

    if (type === "publish") {
      const pub = await publishStaged(appRoot, playerDir, persistDir, files, revisions, dirCache);
      self.postMessage({ id, ok: true, ...pub });
      return;
    }

    if (type === "stage-commit") {
      const staged = await stageEntries(appRoot, playerDir, persistDir, entries, dirCache);
      const pub = await publishStaged(appRoot, playerDir, persistDir, staged.manifestFiles, revisions, dirCache);
      self.postMessage({
        id, ok: true,
        stagedBytes: staged.stagedBytes,
        stageMs: staged.stageMs,
        ...pub,
      });
      return;
    }

    throw new Error("Unsupported save-worker operation: " + type);
  } catch (error) {
    if (!error?.committed && playerDir) {
      try { await removeEntryQuiet(playerDir, "import-stage", true); } catch (_) {}
    }
    const buffers = entries ? entries.map(entry => entry?.bytes || null) : null;
    const transfer = entries ? collectTransferBuffers(entries) : [];
    self.postMessage({
      id, ok: false,
      name: error?.name || "Error",
      message: error?.message || String(error),
      fallback: !!error?.fallback,
      committed: !!error?.committed,
      saveFilePath: error?.saveFilePath || null,
      buffers,
    }, transfer);
  }
};
