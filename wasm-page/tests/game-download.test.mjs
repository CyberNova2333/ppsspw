import assert from 'node:assert/strict';
import test from 'node:test';
import { webcrypto } from 'node:crypto';
import { DownloadError, GameDownload, downloadGame, manifestFingerprint, validateManifest } from '../public/game-download.js';
import { storageLocks } from './storage-locks.mjs';

const CHUNK = 65536;
const digest = async bytes => Buffer.from(await webcrypto.subtle.digest('SHA-256', bytes)).toString('hex');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const missing = () => new DOMException('missing', 'NotFoundError');
const quota = () => new DOMException('full', 'QuotaExceededError');
async function fixture(size = CHUNK * 2 + 17) {
  const bytes = Uint8Array.from({ length: size }, (_, i) => (i * 17 + 3) & 255);
  const sha256 = [];
  for (let offset = 0; offset < size; offset += CHUNK) sha256.push(await digest(bytes.subarray(offset, offset + CHUNK)));
  return { bytes, manifest: { schemaVersion: 1, id: 'test', name: '测试游戏.iso', size, chunkSize: CHUNK,
    sha256, sources: ['https://cdn.example/game.iso'] } };
}

function platform() {
  const files = new Map(), dirs = new Set(['']), reads = [], writes = [];
  const failures = {}, mutations = [];
  const handles = new Set();
  const fileHandle = path => ({
    getFile: async () => {
      if (!files.has(path)) throw missing();
      const value = files.get(path).slice();
      const file = new File([value], path.split('/').pop());
      const original = file.arrayBuffer.bind(file);
      file.arrayBuffer = () => { reads.push({ path, size: file.size }); if (path.endsWith('/game.bin')) throw new Error('full ISO read is forbidden'); return original(); };
      return file;
    },
    createWritable: async () => {
      const chunks = [];
      return {
        write: async value => {
          if (failures.tempWrite && path.endsWith('.tmp')) throw quota();
          chunks.push(typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value).slice());
        },
        close: async () => {
          if (failures.metadata && path.endsWith('/resume.json')) throw quota();
          const result = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
          let offset = 0;
          for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
          files.set(path, result);
        },
        abort: async () => {},
      };
    },
    createSyncAccessHandle: async () => {
      mutations.push('open-write-handle');
      assert.equal(handles.has(path), false, 'file handle must be closed before reuse');
      handles.add(path);
      return {
        getSize: () => files.get(path).length,
        truncate: size => { mutations.push('truncate'); const next = new Uint8Array(size); next.set(files.get(path).subarray(0, size)); files.set(path, next); },
        write: (bytes, { at }) => { if (failures.payload) throw quota(); files.get(path).set(bytes, at); writes.push({ path, at, size: bytes.length }); return bytes.length; },
        flush: () => { mutations.push('flush'); if (failures.flush) throw quota(); },
        close: () => { assert.equal(handles.delete(path), true); },
      };
    },
  });
  const directory = parent => ({
    getDirectoryHandle: async (name, { create = false } = {}) => {
      const path = parent + '/' + name;
      if (!dirs.has(path)) { if (!create) throw missing(); dirs.add(path); }
      return directory(path);
    },
    getFileHandle: async (name, { create = false } = {}) => {
      const path = parent + '/' + name;
      if (!files.has(path)) { if (!create) throw missing(); files.set(path, new Uint8Array()); }
      return fileHandle(path);
    },
    removeEntry: async name => { if (!files.delete(parent + '/' + name)) throw missing(); },
  });
  const storage = { getDirectory: async () => directory(''), estimate: async () => ({ quota: 1024 ** 3, usage: 0 }) };
  const { locks, held } = storageLocks();
  return { storage, locks, crypto: webcrypto, files, held, handles, reads, writes, failures, mutations };
}

function fetchFixture(bytes, calls = [], transform) {
  return async (url, options) => {
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
    const [, startText, endText] = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range);
    const start = Number(startText), end = Number(endText);
    calls.push({ url, start, end });
    const body = bytes.slice(start, end + 1);
    const response = { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${bytes.length}`, 'Content-Length': String(body.length) } };
    return transform ? transform({ body, response, url, options, start, end }) : new Response(body, response);
  };
}

test('manifest validates dimensions, hashes, URL policy and Unicode display filenames', async () => {
  const { manifest } = await fixture();
  const good = validateManifest({ ...manifest, sha256: manifest.sha256.map(h => h.toUpperCase()), sources: ['https://cdn.example/game.iso?version=2'] }, { allowedOrigins: ['https://cdn.example'] });
  assert.equal(good.name, '测试游戏.iso');
  assert.equal(good.sha256[0], manifest.sha256[0]);
  assert.ok(Object.isFrozen(good.sha256));
  for (const change of [{ schemaVersion: 2 }, { size: 0 }, { size: 9 * 1024 ** 3 }, { chunkSize: 32 }, { sha256: [] }, { sha256: Array(3) }, { name: '../game.iso' }, { name: 'game.zip' },
    { sources: ['http://cdn.example/game.iso'] }, { sources: ['https://user:pass@cdn.example/game.iso'] }, { sources: ['https://cdn.example/game.iso#x'] }, { sources: [' https://cdn.example/game.iso'] }]) {
    assert.throws(() => validateManifest({ ...manifest, ...change }), DownloadError);
  }
  assert.throws(() => validateManifest(manifest, { allowedOrigins: [] }), { code: 'SOURCE' });
  assert.equal(validateManifest({ ...manifest, sources: ['http://localhost:17881/game.iso'] }).sources.length, 1);
});

test('content fingerprint survives mirror, title and optional whole-file hash changes', async () => {
  const { manifest } = await fixture();
  assert.equal(await manifestFingerprint(manifest), await manifestFingerprint({ ...manifest, id: 'other', name: 'other.iso', sources: ['https://mirror.example/game.iso'], fileSha256: 'f'.repeat(64) }));
  assert.notEqual(await manifestFingerprint(manifest), await manifestFingerprint({ ...manifest, sha256: ['f'.repeat(64), ...manifest.sha256.slice(1)] }));
});

test('download streams blocks, verifies them and commits payload before completed metadata without a full ISO read', async () => {
  const { manifest, bytes } = await fixture();
  const p = platform(), calls = [], progress = [];
  const result = await downloadGame(manifest, { ...p, fetch: fetchFixture(bytes, calls), onProgress: state => progress.push(state) });
  assert.equal(result.manifest.name, manifest.name);
  assert.deepEqual(calls.map(c => [c.start, c.end]).sort((a, b) => a[0] - b[0]), [[0, CHUNK - 1], [CHUNK, CHUNK * 2 - 1], [CHUNK * 2, bytes.length - 1]]);
  assert.deepEqual(p.files.get('/game-downloads/' + result.fingerprint + '/game.bin'), bytes);
  assert.ok(p.reads.every(read => read.size <= CHUNK));
  assert.equal(p.files.size, 2, 'temporary blocks are removed');
  assert.equal(progress.at(-1).verifiedBytes, bytes.length);
  assert.equal(progress.at(-1).status, 'complete');
  assert.equal(p.held.size, 0);
  assert.equal(p.handles.size, 0);
});

test('verified cache resumes across source changes without fetching or copying completed blocks', async () => {
  const { manifest, bytes } = await fixture();
  const p = platform();
  const first = await downloadGame(manifest, { ...p, fetch: fetchFixture(bytes) });
  p.reads.length = 0;
  p.mutations.length = 0;
  const second = await downloadGame({ ...manifest, sources: ['https://other.example/game.iso'] }, { ...p, fetch: () => assert.fail('completed blocks must not redownload') });
  assert.equal(first.fingerprint, second.fingerprint);
  assert.equal(p.reads.length, 0);
  assert.deepEqual(p.mutations, [], 'reusing a finished file must not invalidate another tab’s File snapshot');
});

test('a changed manifest receives a separate cache while old verified data remains intact', async () => {
  const first = await fixture(CHUNK), second = await fixture(CHUNK);
  second.bytes[0] ^= 255;
  second.manifest.sha256 = [await digest(second.bytes)];
  const p = platform();
  const a = await downloadGame(first.manifest, { ...p, fetch: fetchFixture(first.bytes) });
  const b = await downloadGame(second.manifest, { ...p, fetch: fetchFixture(second.bytes) });
  assert.notEqual(a.fingerprint, b.fingerprint);
  assert.deepEqual(p.files.get('/game-downloads/' + a.fingerprint + '/game.bin'), first.bytes);
});

test('a bad block retries a different mirror and never commits corrupt bytes', async () => {
  const { manifest, bytes } = await fixture(CHUNK);
  manifest.sources.push('https://mirror.example/game.iso');
  const p = platform(), calls = [];
  const fetch = fetchFixture(bytes, calls, ({ body, response, url }) => { if (url.includes('cdn.example')) body[0] ^= 255; return new Response(body, response); });
  await downloadGame(manifest, { ...p, fetch, maxRetries: 1 });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, manifest.sources[1]);
  assert.equal(p.writes.length, 1);
});

test('an interrupted response discards its temporary block and retries from the block boundary', async () => {
  const { manifest, bytes } = await fixture(CHUNK);
  const p = platform(), calls = [];
  let attempts = 0;
  const fetch = fetchFixture(bytes, calls, ({ body, response }) => {
    if (++attempts !== 1) return new Response(body, response);
    let part = 0;
    return new Response(new ReadableStream({ pull(controller) {
      if (part++ === 0) controller.enqueue(body.subarray(0, 1024));
      else controller.error(new TypeError('network disconnected'));
    } }), response);
  });
  await downloadGame(manifest, { ...p, fetch, maxRetries: 1 });
  assert.deepEqual(calls.map(call => call.start), [0, 0]);
  assert.equal(p.writes.length, 1);
});

test('a stalled request is aborted after its idle deadline and releases the download lock', async () => {
  const { manifest } = await fixture(CHUNK);
  const p = platform();
  const fetch = async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  await assert.rejects(downloadGame(manifest, { ...p, fetch, timeoutMs: 1000, maxRetries: 0 }), { code: 'TIMEOUT' });
  assert.equal(p.held.size, 0);
  assert.equal(p.handles.size, 0);
});

test('requested network concurrency cannot exceed four workers', async () => {
  const { manifest, bytes } = await fixture(CHUNK * 9);
  const p = platform();
  let active = 0, peak = 0;
  const fetch = fetchFixture(bytes, [], async ({ body, response }) => {
    active++;
    peak = Math.max(active, peak);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    return new Response(body, response);
  });
  await downloadGame(manifest, { ...p, fetch, concurrency: 999 });
  assert.equal(peak, 4);
});

test('strict Range validation rejects ignored Range, shifted ranges, compression and short/long responses', async () => {
  const { manifest, bytes } = await fixture(CHUNK);
  const cases = [
    ({ body }) => new Response(body, { status: 200 }),
    ({ body, response }) => new Response(body, { ...response, headers: { 'Content-Range': `bytes 1-${CHUNK}/${CHUNK}` } }),
    ({ body, response }) => new Response(body, { ...response, headers: { ...response.headers, 'Content-Encoding': 'gzip' } }),
    ({ body, response }) => new Response(body.subarray(0, body.length - 1), response),
    ({ body, response }) => new Response(new Uint8Array(body.length + 1), response),
    ({ body, response }) => new Response(body, { ...response, headers: { ...response.headers, 'Content-Length': 'wrong' } }),
  ];
  for (const transform of cases) {
    const p = platform();
    await assert.rejects(downloadGame(manifest, { ...p, fetch: fetchFixture(bytes, [], transform), maxRetries: 0 }));
    assert.equal(p.writes.length, 0);
    assert.equal(p.held.size, 0);
    assert.equal(p.handles.size, 0);
  }
});

test('pausing preserves committed blocks and resumes only the missing ranges', async () => {
  const { manifest, bytes } = await fixture();
  const p = platform(), firstCalls = [], secondCalls = [];
  const controller = new AbortController();
  const fetch = fetchFixture(bytes, firstCalls, ({ body, response, start }) => {
    if (start === CHUNK) { controller.abort(new DOMException('pause', 'AbortError')); throw controller.signal.reason; }
    return new Response(body, response);
  });
  await assert.rejects(downloadGame(manifest, { ...p, fetch, concurrency: 1, signal: controller.signal }), { name: 'AbortError' });
  await downloadGame(manifest, { ...p, concurrency: 1, fetch: fetchFixture(bytes, secondCalls) });
  assert.deepEqual(secondCalls.map(call => call.start), [CHUNK, CHUNK * 2]);
});

test('late network reads after pause cannot write and keep the lock until their cleanup finishes', async () => {
  const { manifest } = await fixture(CHUNK);
  const p = platform(), controller = new AbortController();
  let release, reading;
  const entered = new Promise(resolve => { reading = resolve; });
  const fetch = async () => ({ status: 206, headers: new Headers({ 'Content-Range': `bytes 0-${CHUNK - 1}/${CHUNK}` }),
    body: { getReader: () => ({ read: () => { reading(); return new Promise(resolve => { release = resolve; }); }, cancel: async () => {} }) } });
  const active = downloadGame(manifest, { ...p, fetch, signal: controller.signal });
  const rejected = assert.rejects(active, { name: 'AbortError' });
  await entered;
  controller.abort(new DOMException('pause', 'AbortError'));
  await assert.rejects(downloadGame(manifest, { ...p, fetch }), { code: 'BUSY' });
  assert.equal(p.held.size, 2);
  release({ done: false, value: new Uint8Array(CHUNK) });
  await rejected;
  assert.equal(p.writes.length, 0);
  assert.equal(p.held.size, 0);
  assert.equal(p.handles.size, 0);
});

test('disk full during payload or journal writes never reports success and remains resumable', async () => {
  const { manifest, bytes } = await fixture(CHUNK);
  for (const failure of ['tempWrite', 'payload', 'flush', 'metadata']) {
    const p = platform();
    p.failures[failure] = true;
    await assert.rejects(downloadGame(manifest, { ...p, fetch: fetchFixture(bytes), maxRetries: 0 }), { code: 'STORAGE' });
    assert.equal(p.held.size, 0);
    assert.equal(p.handles.size, 0);
    delete p.failures[failure];
    const calls = [];
    await downloadGame(manifest, { ...p, fetch: fetchFixture(bytes, calls) });
    assert.equal(calls.length, 1, 'an uncommitted block must be fetched again');
  }
});

test('storage preflight fails before any network request', async () => {
  const { manifest } = await fixture();
  const p = platform();
  p.storage.estimate = async () => ({ quota: 1, usage: 0 });
  await assert.rejects(downloadGame(manifest, { ...p, fetch: () => assert.fail('network must not start') }), { code: 'STORAGE' });
  assert.equal(p.handles.size, 0);
});

test('concurrent workers stop together after a terminal error and do not commit late data', async () => {
  const { manifest, bytes } = await fixture();
  const p = platform();
  let release, started;
  const waiting = new Promise(resolve => { started = resolve; });
  const fetch = fetchFixture(bytes, [], async ({ body, response, start }) => {
    if (start === 0) { await waiting; return new Response(body, { status: 200 }); }
    started();
    await new Promise(resolve => { release = resolve; });
    return new Response(body, response);
  });
  const operation = downloadGame(manifest, { ...p, fetch, concurrency: 2, maxRetries: 0 });
  const rejection = assert.rejects(operation, { code: 'RANGE' });
  await waiting;
  await tick();
  assert.equal(p.held.size, 2);
  release();
  await rejection;
  assert.equal(p.writes.length, 0);
  assert.equal(p.handles.size, 0);
});

test('UI facade deduplicates starts, waits for pause acknowledgement and restores the declared filename', async t => {
  const { manifest } = await fixture(CHUNK);
  const instances = [];
  class FakeWorker {
    constructor() { this.sent = []; instances.push(this); }
    postMessage(message) { this.sent.push(message); }
    terminate() { this.terminated = true; }
    emit(data) { this.onmessage({ data }); }
  }
  const originalWorker = globalThis.Worker;
  globalThis.Worker = FakeWorker;
  t.after(() => { if (originalWorker === undefined) delete globalThis.Worker; else globalThis.Worker = originalWorker; });
  const game = new GameDownload(manifest);
  const operation = game.start();
  assert.equal(game.start(), operation);
  let paused = false;
  const pause = game.pause().then(() => { paused = true; });
  await tick();
  assert.equal(paused, false);
  instances[0].emit({ type: 'paused' });
  await pause;
  assert.equal(await operation, null);
  assert.equal(instances[0].terminated, true);
  const resume = game.resume();
  instances[1].emit({ type: 'complete', fingerprint: 'content-id', handle: { getFile: async () => new File(['data'], 'game.bin') } });
  const result = await resume;
  assert.equal(result.file.name, manifest.name);
  assert.equal(await result.file.text(), 'data');
  assert.equal(game.state.status, 'complete');
});

test('downloads share a playing page lease while excluding cache deletion and imports', async () => {
  const { manifest, bytes } = await fixture(CHUNK);
  const p = platform();
  const release = await globalThis.PpssppGameStorage.acquireShared(p.locks);
  try {
    const fetch = fetchFixture(bytes, [], async ({ body, response }) => {
      await assert.rejects(globalThis.PpssppGameStorage.withExclusive(() => assert.fail('cache changed'), p.locks), { code: 'BUSY' });
      return new Response(body, response);
    });
    await downloadGame(manifest, { ...p, fetch });
    assert.equal(p.held.size, 1);
    assert.equal(p.held.get('ppsspp-game-storage').count, 1);
  } finally { release(); }
});

test('cache maintenance prevents downloads from creating or truncating game data', async () => {
  const { manifest } = await fixture(CHUNK);
  const p = platform();
  await globalThis.PpssppGameStorage.withExclusive(async () => {
    await assert.rejects(downloadGame(manifest, { ...p, fetch: () => assert.fail('network started') }), { code: 'BUSY' });
    assert.equal(p.files.size, 0);
    assert.deepEqual(p.mutations, []);
  }, p.locks);
  assert.equal(p.held.size, 0);
});
