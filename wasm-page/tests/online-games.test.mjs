import assert from 'node:assert/strict';
import test from 'node:test';
import { readCatalogJSON, validateCatalog, validateDownloadSources } from '../public/online-games.js';

const base = 'https://player.example/path/game-catalog.json';
const valid = () => ({ schemaVersion: 1, allowedOrigins: ['https://download.example'], games: [{ title: '游戏', manifest: 'game-manifests/game.json' }] });

test('catalog resolves a same-origin manifest under the deployed base directory', () => {
  assert.deepEqual(validateCatalog(valid(), base), {
    allowedOrigins: ['https://download.example'], games: [{ title: '游戏', manifestURL: 'https://player.example/path/game-manifests/game.json' }],
  });
  assert.deepEqual(validateCatalog({ schemaVersion: 1, allowedOrigins: [], games: [] }, base).games, []);
});

test('catalog rejects off-origin manifests, credentials, insecure or non-origin allowlist entries', () => {
  for (const manifest of ['https://other.example/a.json', 'https://user:password@player.example/a.json', 'data:application/json,{}']) {
    const input = valid(); input.games[0].manifest = manifest;
    assert.throws(() => validateCatalog(input, base));
  }
  for (const origin of ['http://download.example', 'https://download.example/path', 'https://download.example/', 'https://user@download.example']) {
    const input = valid(); input.allowedOrigins = [origin];
    assert.throws(() => validateCatalog(input, base));
  }
  const input = valid(); input.games = Array(17).fill(input.games[0]);
  assert.throws(() => validateCatalog(input, base));
});

test('every manifest source must be explicitly allowed', () => {
  const manifest = { sources: ['https://download.example/game.iso', 'https://other.example/game.iso'] };
  assert.throws(() => validateDownloadSources(manifest, ['https://download.example']));
  assert.equal(validateDownloadSources(manifest, ['https://download.example', 'https://other.example']), manifest);
});

test('catalog reads bypass caches and reject redirects', async () => {
  const value = await readCatalogJSON(base, async (url, options) => {
    assert.equal(url, base); assert.equal(options.cache, 'no-store'); assert.equal(options.redirect, 'error');
    return new Response(JSON.stringify(valid()));
  });
  assert.deepEqual(value, valid());
});

test('oversized catalog bodies are canceled before buffering the whole response', async () => {
  let canceled = false;
  const response = new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(128 * 1024)); },
    cancel() { canceled = true; },
  }));
  await assert.rejects(readCatalogJSON(base, async () => response), /过大/);
  assert.equal(canceled, true);
});

test('catalog deadline aborts a stalled fetch and allows the next attempt', async () => {
  let signal;
  await assert.rejects(readCatalogJSON(base, async (_url, options) => {
    signal = options.signal;
    return new Promise(() => {});
  }, { timeoutMs: 20 }), /超时/);
  assert.equal(signal.aborted, true);
  assert.deepEqual(await readCatalogJSON(base, async () => new Response(JSON.stringify(valid()))), valid());
});

test('catalog deadline includes a stalled body and cancels the reader', async () => {
  let canceled = false;
  const response = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{')); },
    cancel() { canceled = true; },
  }));
  await assert.rejects(readCatalogJSON(base, async () => response, { timeoutMs: 20 }), /超时/);
  assert.equal(canceled, true);
});
