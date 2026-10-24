/* Bounded, read-only backing for the emulator's browser file loader. */
(function (root) {
  "use strict";

  const MAX_READ_BYTES = 1024 * 1024;
  const BLOCK_BYTES = 256 * 1024;
  const CACHE_BYTES = 8 * 1024 * 1024;
  const READ_CONCURRENCY = 4;

  function createBrowserFiles(options = {}) {
    const blockBytes = options.blockBytes ?? BLOCK_BYTES;
    const cacheLimit = options.cacheBytes ?? CACHE_BYTES;
    const concurrency = options.concurrency ?? READ_CONCURRENCY;
    if (!Number.isInteger(blockBytes) || blockBytes <= 0 || blockBytes > MAX_READ_BYTES
        || !Number.isInteger(cacheLimit) || cacheLimit < blockBytes || cacheLimit > CACHE_BYTES
        || !Number.isInteger(concurrency) || concurrency <= 0 || concurrency > READ_CONCURRENCY) {
      throw new Error("无效的游戏读取缓存配置");
    }
    const files = new Map();
    const cache = new Map();
    const pending = new Map();
    const waiting = [];
    let activeReads = 0;
    let cacheBytes = 0;
    let generation = 0;
    const metrics = {
      readCount: 0, readBytes: 0, maxReadBytes: 0,
      physicalReadCount: 0, physicalReadBytes: 0, maxPhysicalReadBytes: 0,
      inFlight: 0, maxInFlight: 0, cacheHits: 0, failures: 0,
      lastError: null,
    };

    function validatePath(path) {
      if (typeof path !== "string" || !/^\/browser-games\/[a-zA-Z0-9._-]+$/.test(path)
          || path.endsWith("/.") || path.endsWith("/..")) {
        throw new Error("无效的游戏挂载路径");
      }
    }

    async function acquire() {
      if (activeReads < concurrency) {
        activeReads++;
        return;
      }
      await new Promise(resolve => waiting.push(resolve));
    }

    function release() {
      const next = waiting.shift();
      if (next) next();
      else activeReads--;
    }

    function discard(entry) {
      for (const [key, bytes] of cache) {
        if (key.startsWith(entry.id + ":")) {
          cache.delete(key);
          cacheBytes -= bytes.byteLength;
        }
      }
    }

    async function loadBlock(entry, index) {
      const key = entry.id + ":" + index;
      if (cache.has(key)) {
        const bytes = cache.get(key);
        cache.delete(key);
        cache.set(key, bytes);
        metrics.cacheHits++;
        return bytes;
      }
      if (pending.has(key)) return pending.get(key);
      const request = (async () => {
        const offset = index * blockBytes;
        const end = Math.min(offset + blockBytes, entry.blob.size);
        const perf = root.PpssppPerformance;
        const token = perf?.token();
        const began = token ? root.performance.now() : 0;
        let bytesRead = 0;
        metrics.inFlight++;
        metrics.maxInFlight = Math.max(metrics.maxInFlight, metrics.inFlight);
        try {
          // Always slice first. Reading the complete ISO here defeats this backend.
          const bytes = new Uint8Array(await entry.blob.slice(offset, end).arrayBuffer());
          if (bytes.byteLength !== end - offset) throw new Error("游戏文件读取不完整");
          metrics.physicalReadCount++;
          metrics.physicalReadBytes += bytes.byteLength;
          metrics.maxPhysicalReadBytes = Math.max(metrics.maxPhysicalReadBytes, bytes.byteLength);
          bytesRead = bytes.byteLength;
          while (cacheBytes + bytes.byteLength > cacheLimit && cache.size) {
            const oldest = cache.keys().next().value;
            cacheBytes -= cache.get(oldest).byteLength;
            cache.delete(oldest);
          }
          if (bytes.byteLength <= cacheLimit) {
            cache.set(key, bytes);
            cacheBytes += bytes.byteLength;
          }
          return bytes;
        } finally {
          metrics.inFlight--;
          if (token) perf.recordIO("physical", token, root.performance.now() - began, bytesRead);
        }
      })();
      pending.set(key, request);
      try { return await request; }
      finally { pending.delete(key); }
    }

    return {
      register(path, blob) {
        validatePath(path);
        if (!blob || !Number.isSafeInteger(blob.size) || blob.size <= 0
            || typeof blob.slice !== "function") {
          throw new Error("游戏文件为空或无法读取");
        }
        const previous = files.get(path);
        if (previous?.blob === blob) return path;
        if (previous?.readers) throw new Error("游戏文件正在读取，无法替换");
        if (previous) discard(previous);
        files.set(path, { id: ++generation, blob, readers: 0 });
        return path;
      },
      unregister(path) {
        const entry = files.get(path);
        if (!entry) return;
        if (entry.readers) throw new Error("游戏文件正在读取，无法卸载");
        discard(entry);
        files.delete(path);
      },
      has(path) { return files.has(path); },
      hasFiles() { return files.size > 0; },
      size(path) { return files.get(path)?.blob.size ?? -1; },
      mirror(FS, path) {
        validatePath(path);
        const entry = files.get(path);
        if (!entry) throw new Error("游戏文件尚未挂载");
        FS.mkdirTree("/browser-games");
        try { FS.unlink(path); }
        catch (error) { if (error.errno !== 44) throw error; } // ENOENT
        // A zero-content, read-only directory entry supports PPSSPP's browser
        // and stat checks. Only BrowserFileLoader may read the actual content.
        FS.createDataFile("/browser-games", path.slice(15), new Uint8Array(0), true, false);
        const node = FS.lookupPath(path).node;
        const originalGetattr = node.node_ops.getattr;
        node.node_ops = {
          ...node.node_ops,
          getattr(current) {
            const info = originalGetattr(current);
            info.size = entry.blob.size;
            info.blocks = Math.ceil(info.size / 4096);
            return info;
          },
          setattr() { throw new FS.ErrnoError(69); }, // EROFS
        };
        node.stream_ops = {
          ...node.stream_ops,
          read() { throw new FS.ErrnoError(29); }, // EIO; use BrowserFileLoader
          write() { throw new FS.ErrnoError(69); },
          llseek(stream, offset, whence) {
            const position = offset + (whence === 1 ? stream.position : whence === 2 ? entry.blob.size : 0);
            if (position < 0) throw new FS.ErrnoError(28); // EINVAL
            return position;
          },
        };
        return path;
      },
      stats() {
        return {
          ...metrics, files: files.size,
          totalFileBytes: [...files.values()].reduce((sum, entry) => sum + entry.blob.size, 0),
          cacheBytes, cacheLimit, blockBytes, maxRequestBytes: MAX_READ_BYTES,
          activeReads, queuedReads: waiting.length,
        };
      },
      async read(path, offset, length) {
        if (!Number.isSafeInteger(offset) || offset < 0
            || !Number.isInteger(length) || length < 0 || length > MAX_READ_BYTES) {
          throw new Error("无效的游戏读取范围");
        }
        const entry = files.get(path);
        if (!entry) throw new Error("游戏文件已卸载");
        // Reserve the entry before queuing, so callers cannot replace a pending read.
        const perf = root.PpssppPerformance;
        const token = perf?.token();
        const began = token ? root.performance.now() : 0;
        let bytesRead = 0, failed = false;
        entry.readers++;
        await acquire();
        if (token) perf.recordIO("queue", token, root.performance.now() - began);
        try {
          const wanted = Math.min(length, Math.max(0, entry.blob.size - offset));
          const result = new Uint8Array(wanted);
          metrics.readCount++;
          metrics.maxReadBytes = Math.max(metrics.maxReadBytes, wanted);
          let copied = 0;
          while (copied < wanted) {
            const position = offset + copied;
            const block = await loadBlock(entry, Math.floor(position / blockBytes));
            const within = position % blockBytes;
            const count = Math.min(wanted - copied, block.byteLength - within);
            if (count <= 0) throw new Error("游戏文件读取不完整");
            result.set(block.subarray(within, within + count), copied);
            copied += count;
          }
          metrics.readBytes += copied;
          bytesRead = copied;
          return result;
        } catch (error) {
          failed = true;
          metrics.failures++;
          metrics.lastError = { path, message: String(error?.message || error) };
          if (typeof root.dispatchEvent === "function" && typeof root.CustomEvent === "function") {
            root.dispatchEvent(new root.CustomEvent("ppsspp:game-read-error", { detail: metrics.lastError }));
          }
          throw error;
        } finally {
          entry.readers--;
          release();
          if (token) perf.recordIO("request", token, root.performance.now() - began, bytesRead, failed);
        }
      },
    };
  }

  root.createPpssppBrowserFiles = createBrowserFiles;
  root.PpssppBrowserFiles = createBrowserFiles();
})(globalThis);
