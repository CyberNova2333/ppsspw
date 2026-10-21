import './browser-storage.js';

// CDN downloads use bounded blocks in a worker; the ISO never becomes one JS buffer.
export class DownloadError extends Error {
  constructor(code, message) { super(message); this.name = 'DownloadError'; this.code = code; }
}

const MAX_SIZE = 8 * 1024 ** 3;
const MAX_CHUNK = 16 * 1024 ** 2;
const HEX = /^[a-f0-9]{64}$/i;
const fail = (code, message) => { throw new DownloadError(code, message); };
const stopped = signal => { if (signal?.aborted) throw signal.reason || new DOMException('下载已暂停', 'AbortError'); };
const hex = bytes => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');

/** schemaVersion, id, name, size, chunkSize, sha256[], sources[]; fileSha256 is optional metadata. */
export function validateManifest(input, { allowedOrigins } = {}) {
  if (!input || input.schemaVersion !== 1) fail('MANIFEST', '下载清单版本不受支持');
  if (typeof input.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(input.id)) fail('MANIFEST', '下载清单标识无效');
  if (typeof input.name !== 'string' || /[\\/:\u0000-\u001f\u007f]/.test(input.name)
      || new TextEncoder().encode(input.name).byteLength > 255 || !/^.+\.(iso|cso|chd|pbp)$/i.test(input.name)) fail('MANIFEST', '游戏文件名无效');
  if (!Number.isSafeInteger(input.size) || input.size < 1 || input.size > MAX_SIZE) fail('MANIFEST', '游戏文件大小超出支持范围');
  if (!Number.isSafeInteger(input.chunkSize) || input.chunkSize < 65536 || input.chunkSize > MAX_CHUNK) fail('MANIFEST', '校验块大小必须为 64 KiB 至 16 MiB');
  if (!Array.isArray(input.sha256) || input.sha256.length !== Math.ceil(input.size / input.chunkSize)
      || Array.from(input.sha256).some(hash => typeof hash !== 'string' || !HEX.test(hash))) fail('MANIFEST', '分块校验清单与文件大小不匹配');
  if (!Array.isArray(input.sources) || !input.sources.length || input.sources.length > 6) fail('MANIFEST', '下载来源数量必须为 1 至 6');
  if (allowedOrigins !== undefined && (!Array.isArray(allowedOrigins) || allowedOrigins.some(origin => typeof origin !== 'string'))) fail('MANIFEST', '允许的下载来源配置无效');
  const sources = input.sources.map(source => {
    let url;
    try { if (typeof source !== 'string' || /[\s\\\u0000-\u001f\u007f]/.test(source)) throw new Error(); url = new URL(source); }
    catch { fail('MANIFEST', '下载地址无效'); }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.hash) fail('MANIFEST', '下载地址必须使用 HTTPS，且不能包含登录凭证或片段');
    if (allowedOrigins && !allowedOrigins.includes(url.origin)) fail('SOURCE', '下载地址不在允许的来源中');
    return url.href;
  });
  if (input.fileSha256 !== undefined && (typeof input.fileSha256 !== 'string' || !HEX.test(input.fileSha256))) fail('MANIFEST', '完整文件校验值无效');
  return Object.freeze({ schemaVersion: 1, id: input.id, name: input.name, size: input.size,
    chunkSize: input.chunkSize, sha256: Object.freeze(input.sha256.map(value => value.toLowerCase())),
    sources: Object.freeze([...new Set(sources)]),
    ...(input.fileSha256 ? { fileSha256: input.fileSha256.toLowerCase() } : {}) });
}

export async function manifestFingerprint(manifest, crypto = globalThis.crypto) {
  // Mirrors and their ETags do not identify content. A changed block list gets a new cache.
  const identity = JSON.stringify([1, manifest.size, manifest.chunkSize, manifest.sha256]);
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity)));
}

function normalizedError(error) {
  if (error?.name === 'GameStorageError') return new DownloadError(error.code, error.message);
  if (error?.name === 'QuotaExceededError') return new DownloadError('STORAGE', '浏览器存储空间不足，请清理缓存后继续下载');
  if (error?.name === 'AbortError' || error instanceof DownloadError) return error;
  return new DownloadError('DOWNLOAD', '下载未完成，请检查网络、下载来源和浏览器存储后重试');
}

function optionsFor(input = {}) {
  return { concurrency: Math.max(1, Math.min(4, Math.floor(Number(input.concurrency) || 2))),
    maxRetries: Math.max(0, Math.min(5, Math.floor(Number(input.maxRetries ?? 3) || 0))),
    timeoutMs: Math.max(1000, Math.min(120000, Number(input.timeoutMs) || 30000)) };
}

async function writeJSON(dir, name, value) {
  const handle = await dir.getFileHandle(name, { create: true });
  const stream = await handle.createWritable();
  try { await stream.write(JSON.stringify(value)); await stream.close(); }
  catch (error) { try { await stream.abort(); } catch {} throw error; }
}

async function readResume(dir, fingerprint, count) {
  try {
    const handle = await dir.getFileHandle('resume.json');
    const file = await handle.getFile();
    if (file.size > count * 2 + 1024) return null;
    const value = JSON.parse(await file.text());
    return value.version === 1 && value.fingerprint === fingerprint && Array.isArray(value.verified)
      && value.verified.length === count && value.verified.every(v => v === 0 || v === 1) ? value.verified : null;
  } catch (error) {
    if (error.name === 'NotFoundError' || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function removeTemp(dir, name) {
  try { await dir.removeEntry(name); } catch (error) { if (error.name !== 'NotFoundError') throw error; }
}

function pauseDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    stopped(signal);
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** Worker-side engine. Injectable platform objects keep fault tests independent of a browser. */
export async function downloadGame(input, options = {}) {
  const manifest = validateManifest(input, options);
  const config = optionsFor(options);
  const storage = options.storage || globalThis.navigator?.storage;
  const locks = options.locks || globalThis.navigator?.locks;
  const crypto = options.crypto || globalThis.crypto;
  const fetcher = options.fetch || globalThis.fetch;
  if (!storage?.getDirectory || !locks?.request || !crypto?.subtle) fail('UNSUPPORTED', '此浏览器不支持安全的断点下载，请使用本地游戏文件');
  const signal = options.signal || new AbortController().signal;
  stopped(signal);
  const fingerprint = await manifestFingerprint(manifest, crypto);
  stopped(signal);
  try {
    return await globalThis.PpssppGameStorage.withShared(() => locks.request('ppsspp-download-' + fingerprint, { mode: 'exclusive', ifAvailable: true }, async lock => {
      if (!lock) fail('BUSY', '另一个页面正在下载此游戏，请返回该页面或等待下载结束');
      stopped(signal);
      const root = await storage.getDirectory();
      const downloads = await root.getDirectoryHandle('game-downloads', { create: true });
      const dir = await downloads.getDirectoryHandle(fingerprint, { create: true });
      const handle = await dir.getFileHandle('game.bin', { create: true });
      let verified = await readResume(dir, fingerprint, manifest.sha256.length);
      let existingSize = (await handle.getFile()).size;
      if (existingSize !== manifest.size) verified = null;
      stopped(signal);
      if (verified?.every(value => value === 1)) {
        // A write handle/truncate can invalidate a File snapshot in another playing tab.
        // Reusing a completed transaction must be entirely read-only.
        options.onProgress?.({ status: 'complete', id: manifest.id, name: manifest.name, total: manifest.size,
          verifiedBytes: manifest.size, receivedBytes: manifest.size, completedChunks: verified.length,
          totalChunks: verified.length, speedBytesPerSecond: 0, message: '已读取下载完成的游戏缓存' });
        return { handle, manifest, fingerprint };
      }
      if (!handle.createSyncAccessHandle) fail('UNSUPPORTED', '此浏览器不支持低内存游戏下载，请使用本地游戏文件');
      const output = await handle.createSyncAccessHandle();
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      const activeSignal = controller.signal;
      try {
        existingSize = output.getSize();
      } catch (error) {
        signal.removeEventListener('abort', abort);
        output.close();
        throw error;
      }
      if (existingSize !== manifest.size) verified = null;
      verified ||= Array(manifest.sha256.length).fill(0);
      const blockBytes = i => Math.min(manifest.chunkSize, manifest.size - i * manifest.chunkSize);
      let verifiedBytes = verified.reduce((sum, v, i) => sum + (v ? blockBytes(i) : 0), 0);
      const initialBytes = verifiedBytes;
      const started = performance.now();
      const inflight = new Map();
      let lastUpdate = -Infinity;
      const progress = (status, force = false) => {
        const now = performance.now();
        if (!force && now - lastUpdate < 100) return;
        lastUpdate = now;
        options.onProgress?.({ status, id: manifest.id, name: manifest.name, total: manifest.size,
          verifiedBytes, receivedBytes: verifiedBytes + [...inflight.values()].reduce((a, b) => a + b, 0),
          completedChunks: verified.reduce((sum, v) => sum + v, 0), totalChunks: verified.length,
          speedBytesPerSecond: (verifiedBytes - initialBytes) / Math.max(1, (now - started) / 1000),
          message: status === 'complete' ? '下载完成，校验通过' : '正在下载并校验游戏' });
      };
      let commitQueue = Promise.resolve();
      const commit = (index, bytes) => {
        const pending = commitQueue.then(async () => {
          stopped(activeSignal);
          let offset = 0;
          while (offset < bytes.byteLength) {
            const written = output.write(bytes.subarray(offset), { at: index * manifest.chunkSize + offset });
            if (!(written > 0)) fail('STORAGE', '无法继续写入游戏缓存');
            offset += written;
          }
          output.flush();
          // Durable payload first, then the journal. A crash can only redownload a block.
          verified[index] = 1;
          await writeJSON(dir, 'resume.json', { version: 1, fingerprint, verified });
          verifiedBytes += bytes.byteLength;
          inflight.delete(index);
          progress('downloading');
        });
        commitQueue = pending.catch(() => {});
        return pending;
      };

      const fetchBlock = async (index, attempt) => {
        stopped(activeSignal);
        const request = new AbortController();
        const stopRequest = () => request.abort(activeSignal.reason);
        activeSignal.addEventListener('abort', stopRequest, { once: true });
        let timer;
        const resetTimeout = () => { clearTimeout(timer); timer = setTimeout(() => request.abort(new DownloadError('TIMEOUT', '下载连接超时')), config.timeoutMs); };
        const tempName = 'block-' + index + '.tmp';
        let writable, reader, closed = false;
        try {
          resetTimeout();
          const start = index * manifest.chunkSize;
          const expected = blockBytes(index);
          const end = start + expected - 1;
          const response = await fetcher(manifest.sources[attempt % manifest.sources.length], {
            method: 'GET', mode: 'cors', credentials: 'omit', redirect: 'error', cache: 'no-store',
            headers: { Range: `bytes=${start}-${end}` }, signal: request.signal,
          });
          if (response.status !== 206) fail('RANGE', '下载来源未返回正确的分块响应');
          const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('Content-Range') || '');
          if (!range || Number(range[1]) !== start || Number(range[2]) !== end || Number(range[3]) !== manifest.size) fail('RANGE', '下载来源返回了错误的分块范围');
          const length = response.headers.get('Content-Length');
          if (length !== null && (!/^\d+$/.test(length) || Number(length) !== expected)) fail('RANGE', '下载分块长度与清单不一致');
          const encoding = response.headers.get('Content-Encoding');
          if (encoding && encoding !== 'identity') fail('RANGE', '下载来源不能对游戏分块进行传输压缩');
          if (!response.body) fail('NETWORK', '浏览器未提供下载数据流');
          reader = response.body.getReader();
          const temp = await dir.getFileHandle(tempName, { create: true });
          writable = await temp.createWritable();
          let received = 0;
          while (true) {
            stopped(activeSignal);
            resetTimeout();
            const { done, value } = await reader.read();
            if (done) break;
            stopped(activeSignal);
            received += value.byteLength;
            if (received > expected) fail('RANGE', '下载分块超出清单规定的大小');
            await writable.write(value);
            inflight.set(index, received);
            progress('downloading');
          }
          clearTimeout(timer);
          if (received !== expected) fail('NETWORK', '下载分块不完整');
          await writable.close(); closed = true;
          stopped(activeSignal);
          // WebCrypto needs a complete block, bounded by MAX_CHUNK, never the complete ISO.
          const bytes = new Uint8Array(await (await temp.getFile()).arrayBuffer());
          const digest = hex(await crypto.subtle.digest('SHA-256', bytes));
          stopped(activeSignal);
          if (digest !== manifest.sha256[index]) fail('HASH', '下载分块校验失败，正在尝试重新下载');
          await commit(index, bytes);
        } catch (error) {
          if (request.signal.aborted && !activeSignal.aborted) throw request.signal.reason;
          throw error;
        } finally {
          clearTimeout(timer);
          request.abort();
          activeSignal.removeEventListener('abort', stopRequest);
          try { await reader?.cancel(); } catch {}
          if (writable && !closed) { try { await writable.abort(); } catch {} }
          inflight.delete(index);
          await removeTemp(dir, tempName);
        }
      };

      let firstError;
      try {
        stopped(activeSignal);
        const remaining = manifest.size - verifiedBytes;
        if (remaining && storage.estimate) {
          const estimate = await storage.estimate();
          const needed = Math.max(0, manifest.size - existingSize) + Math.min(config.concurrency, verified.filter(v => !v).length) * Math.min(manifest.chunkSize, manifest.size) + 1024 * 1024;
          if (Number.isFinite(estimate.quota) && Number.isFinite(estimate.usage) && estimate.quota - estimate.usage < needed) fail('STORAGE', '浏览器可用存储空间不足，请清理缓存后继续下载');
        }
        if (existingSize !== manifest.size) output.truncate(manifest.size);
        progress('downloading', true);
        const pending = verified.map((v, i) => v ? -1 : i).filter(i => i >= 0);
        let next = 0;
        const worker = async () => {
          try {
            while (next < pending.length) {
              stopped(activeSignal);
              const index = pending[next++];
              for (let attempt = 0; ; attempt++) {
                try { await fetchBlock(index, attempt); break; }
                catch (error) {
                  stopped(activeSignal);
                  const normalized = normalizedError(error);
                  if (normalized.code === 'STORAGE' || attempt >= config.maxRetries) throw normalized;
                  await pauseDelay(Math.min(2000, 200 * 2 ** attempt), activeSignal);
                }
              }
            }
          } catch (error) {
            firstError ||= error;
            controller.abort(error);
          }
        };
        // Keep the Web Lock until every fetch, queued write and cleanup has settled.
        await Promise.all(Array.from({ length: Math.min(config.concurrency, pending.length) }, worker));
        await commitQueue;
        if (firstError) throw firstError;
        stopped(activeSignal);
        progress('complete', true);
        return { handle, manifest, fingerprint };
      } finally {
        controller.abort();
        signal.removeEventListener('abort', abort);
        output.close();
      }
    }), locks);
  } catch (error) { throw normalizedError(error); }
}

/** UI facade. pause() waits for writes and lock release; start() can then resume safely. */
export class GameDownload {
  constructor(manifest, options = {}) {
    this.manifest = validateManifest(manifest, options);
    this.options = { ...optionsFor(options), ...(options.allowedOrigins ? { allowedOrigins: [...options.allowedOrigins] } : {}) };
    this.listeners = new Set();
    this.state = { status: 'idle', id: this.manifest.id, name: this.manifest.name, total: this.manifest.size,
      verifiedBytes: 0, receivedBytes: 0, completedChunks: 0, totalChunks: this.manifest.sha256.length, speedBytesPerSecond: 0, message: '等待下载' };
    this.running = null;
    this.worker = null;
  }
  subscribe(listener) {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }
  publish(update) {
    this.state = Object.freeze({ ...this.state, ...update });
    for (const listener of this.listeners) { try { listener(this.state); } catch {} }
  }
  start() {
    if (this.running) return this.running;
    this.publish({ status: 'preparing', message: '正在检查下载缓存', error: null });
    const operation = new Promise((resolve, reject) => {
      let worker;
      try { worker = new Worker(new URL('./download-worker.js', import.meta.url), { type: 'module' }); }
      catch { const error = new DownloadError('UNSUPPORTED', '此浏览器无法启动下载线程'); this.publish({ status: 'error', message: error.message, error: error.code }); reject(error); return; }
      this.worker = worker;
      const finish = () => { worker.terminate(); if (this.worker === worker) this.worker = null; };
      worker.onmessage = async ({ data }) => {
        if (this.worker !== worker) return;
        if (data.type === 'progress') this.publish({ ...data.state, ...(this.state.status === 'pausing' ? { status: 'pausing', message: '正在保存下载进度' } : {}) });
        if (data.type === 'paused') { finish(); this.publish({ status: 'paused', message: '已暂停，已校验的分块会保留' }); resolve(null); }
        if (data.type === 'complete') {
          finish();
          try { const stored = await data.handle.getFile(); const file = new File([stored], this.manifest.name, { type: 'application/octet-stream', lastModified: stored.lastModified }); this.publish({ status: 'complete', message: '下载完成，校验通过' }); resolve({ handle: data.handle, fingerprint: data.fingerprint, file, manifest: this.manifest }); }
          catch (error) { this.publish({ status: 'error', message: '无法读取已下载的游戏' }); reject(normalizedError(error)); }
        }
        if (data.type === 'error') { finish(); const error = new DownloadError(data.code, data.message); this.publish({ status: 'error', message: error.message, error: error.code }); reject(error); }
      };
      worker.onerror = event => { event.preventDefault(); finish(); const error = new DownloadError('WORKER', '下载线程未能运行，请刷新页面后重试'); this.publish({ status: 'error', message: error.message, error: error.code }); reject(error); };
      worker.postMessage({ type: 'start', manifest: this.manifest, options: this.options });
    });
    this.running = operation.finally(() => { this.running = null; });
    return this.running;
  }
  resume() { return this.start(); }
  async pause() {
    if (!this.running) return;
    this.publish({ status: 'pausing', message: '正在保存下载进度' });
    this.worker?.postMessage({ type: 'pause' });
    await this.running;
  }
}
