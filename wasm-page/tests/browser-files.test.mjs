import assert from 'node:assert/strict';
import test from 'node:test';
import '../public/browser-files.js';

const create = globalThis.createPpssppBrowserFiles;
const path = '/browser-games/test.iso';

function patternedFile(size, { delay = 0, reject = false } = {}) {
  const reads = [];
  return {
    size, reads,
    arrayBuffer() { throw new Error('whole-file reads are forbidden'); },
    slice(start, end) {
      reads.push([start, end]);
      return { async arrayBuffer() {
        if (delay) await new Promise(resolve => setTimeout(resolve, delay));
        if (reject) throw new Error('file unavailable');
        return Uint8Array.from({ length: end - start }, (_, i) => (start + i) % 251).buffer;
      } };
    },
  };
}

test('registering a large game stores its handle without reading or allocating its content', () => {
  const files = create();
  const source = patternedFile(1_400_000_000);
  assert.equal(files.register(path, source), path);
  assert.equal(files.size(path), source.size);
  assert.equal(files.hasFiles(), true);
  assert.deepEqual(source.reads, []);
  assert.equal(files.stats().cacheBytes, 0);
  assert.equal(files.stats().totalFileBytes, source.size);
});

test('bounded reads cross block boundaries and preserve offsets above 2 GiB', async () => {
  const files = create({ blockBytes: 32, cacheBytes: 128 });
  const source = patternedFile(3_000_000_000);
  files.register(path, source);
  const offset = 2 ** 31 + 27;
  const bytes = await files.read(path, offset, 65);
  assert.deepEqual(bytes, Uint8Array.from({ length: 65 }, (_, i) => (offset + i) % 251));
  assert.ok(source.reads.every(([start, end]) => end - start <= 32 && start >= 2 ** 31));
  assert.equal(files.stats().readBytes, 65);
  assert.equal(files.stats().maxReadBytes, 65);
});

test('EOF returns only available bytes and reading beyond EOF returns empty', async () => {
  const files = create();
  files.register(path, new Blob([Uint8Array.of(1, 2, 3, 4)]));
  assert.deepEqual(await files.read(path, 2, 100), Uint8Array.of(3, 4));
  assert.equal((await files.read(path, 100, 10)).length, 0);
  assert.equal((await files.read(path, 0, 0)).length, 0);
});

test('invalid and oversized ranges fail before touching the source', async () => {
  const files = create();
  const source = patternedFile(2_000_000);
  files.register(path, source);
  for (const [offset, length] of [[-1, 1], [0, -1], [0.5, 1], [0, 2 ** 20 + 1], [Infinity, 1]]) {
    await assert.rejects(files.read(path, offset, length), /读取范围/);
  }
  assert.deepEqual(source.reads, []);
});

test('repeated small reads share bounded cached blocks and LRU evicts old data', async () => {
  const files = create({ blockBytes: 32, cacheBytes: 64 });
  const source = patternedFile(1024);
  files.register(path, source);
  await files.read(path, 0, 8);
  await files.read(path, 8, 8);
  assert.equal(source.reads.length, 1);
  await files.read(path, 32, 8);
  await files.read(path, 64, 8);
  assert.equal(files.stats().cacheBytes, 64);
  await files.read(path, 0, 8);
  assert.equal(source.reads.length, 4);
  assert.ok(files.stats().cacheBytes <= 64);
});

test('concurrent readers deduplicate requests and limit active allocations', async () => {
  const files = create({ blockBytes: 32, cacheBytes: 64, concurrency: 2 });
  const source = patternedFile(1024, { delay: 10 });
  files.register(path, source);
  const reads = Array.from({ length: 12 }, (_, i) => files.read(path, Math.floor(i / 2) * 32, 16));
  assert.throws(() => files.unregister(path), /正在读取/);
  assert.throws(() => files.register(path, patternedFile(1024)), /正在读取/);
  await Promise.all(reads);
  assert.equal(source.reads.length, 6);
  assert.ok(files.stats().maxInFlight <= 2);
  assert.equal(files.stats().activeReads, 0);
  assert.equal(files.stats().queuedReads, 0);
  assert.ok(files.stats().cacheBytes <= 64);
});

test('a failed read rejects, releases queued readers and allows replacement', async () => {
  const files = create({ concurrency: 1 });
  files.register(path, patternedFile(1024, { reject: true }));
  const results = await Promise.allSettled([files.read(path, 0, 8), files.read(path, 0, 8)]);
  assert.ok(results.every(result => result.status === 'rejected'));
  assert.equal(files.stats().failures, 2);
  assert.equal(files.stats().inFlight, 0);
  assert.equal(files.stats().activeReads, 0);
  files.register(path, new Blob([Uint8Array.of(42)]));
  assert.deepEqual(await files.read(path, 0, 1), Uint8Array.of(42));
});

test('unmount and replacement invalidate all cached content for that file', async () => {
  const files = create();
  files.register(path, new Blob([Uint8Array.of(1, 2, 3)]));
  await files.read(path, 0, 3);
  files.register(path, new Blob([Uint8Array.of(4, 5, 6)]));
  assert.deepEqual(await files.read(path, 0, 3), Uint8Array.of(4, 5, 6));
  files.unregister(path);
  assert.equal(files.stats().cacheBytes, 0);
  assert.equal(files.hasFiles(), false);
  assert.equal(files.size(path), -1);
  await assert.rejects(files.read(path, 0, 1), /已卸载/);
});

test('invalid names, directory escapes and empty files are rejected', () => {
  const files = create();
  const source = new Blob(['test']);
  for (const bad of ['/games/test.iso', '/browser-games/../test.iso', '/browser-games/.', '/browser-games/..', '/browser-games/a/b.iso']) {
    assert.throws(() => files.register(bad, source), /路径/);
  }
  assert.throws(() => files.register(path, new Blob([])), /为空/);
});
