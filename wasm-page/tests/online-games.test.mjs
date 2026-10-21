import assert from 'node:assert/strict';
import test from 'node:test';
import { initOnlineGames, readManifestFile, readManifestJSON, validateManifestURL } from '../public/online-games.js';

const url = 'https://download.example/manifest.json';
const valid = (name = '测试游戏.iso') => ({ schemaVersion: 1, id: 'test', name, size: 65536, chunkSize: 65536,
  sha256: ['a'.repeat(64)], sources: ['https://download.example/game.iso', 'https://mirror.example/game.iso'] });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const jsonFile = value => new File([JSON.stringify(value)], 'manifest.json', { type: 'application/json' });

test('manifest addresses require absolute HTTPS without credentials, fragments or ambiguous characters', () => {
  assert.equal(validateManifestURL(url + '?version=2'), url + '?version=2');
  for (const host of ['localhost', '127.0.0.1', '[::1]']) assert.equal(validateManifestURL(`http://${host}:17882/test.json`), `http://${host}:17882/test.json`);
  for (const value of ['', '/manifest.json', '//download.example/a.json', 'http://download.example/a.json',
    'https://user:password@download.example/a.json', 'https://download.example/a.json#',
    ' https://download.example/a.json', 'https://download.example/a\\b.json', 'data:application/json,{}', 'file:///tmp/a.json']) {
    assert.throws(() => validateManifestURL(value));
  }
});

test('explicit manifest fetch omits credentials, bypasses caches and rejects redirects', async () => {
  const value = await readManifestJSON(url, async (address, options) => {
    assert.equal(address, url); assert.equal(options.cache, 'no-store'); assert.equal(options.mode, 'cors');
    assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
    return new Response(JSON.stringify(valid()));
  });
  assert.deepEqual(value, valid());
  await assert.rejects(readManifestJSON('http://other.example/a.json', () => assert.fail('insecure address fetched')));
  await assert.rejects(readManifestJSON(url, async () => new Response('', { status: 404 })), /404/);
  await assert.rejects(readManifestJSON(url, async () => { throw new TypeError('Failed to fetch'); }), /无法读取清单/);
});

test('oversized bodies cancel the stream before buffering the complete manifest', async () => {
  let canceled = false;
  const response = new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(128 * 1024)); },
    cancel() { canceled = true; },
  }));
  await assert.rejects(readManifestJSON(url, async () => response), /1 MiB/);
  assert.equal(canceled, true);
  let read = false;
  await assert.rejects(readManifestJSON(url, async () => ({ ok: true, headers: new Headers({ 'Content-Length': 1024 * 1024 + 1 }),
    body: { cancel: async () => {}, getReader: () => { read = true; } } })), /1 MiB/);
  assert.equal(read, false);
});

test('local files use the same bounded JSON reader and reject oversized files before opening them', async () => {
  assert.deepEqual(await readManifestFile(jsonFile(valid())), valid());
  await assert.rejects(readManifestFile({ size: 1024 * 1024 + 1, stream: () => assert.fail('oversized file opened') }), /1 MiB/);
  await assert.rejects(readManifestFile(new File([], 'empty.json')), /非空/);
  await assert.rejects(readManifestFile(new File(['{ broken'], 'broken.json')), /有效的 JSON/);
  await assert.rejects(readManifestFile({ size: 1, stream: () => new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)); },
  }) }), /1 MiB/);
});

test('manifest deadline aborts stalled fetches and allows retry', async () => {
  let signal;
  await assert.rejects(readManifestJSON(url, async (_url, options) => {
    signal = options.signal; return new Promise(() => {});
  }, { timeoutMs: 20 }), /超时/);
  assert.equal(signal.aborted, true);
  assert.deepEqual(await readManifestJSON(url, async () => new Response(JSON.stringify(valid()))), valid());
});

test('the deadline includes URL and local-file body reads and cancels either stalled reader', async () => {
  for (const local of [false, true]) {
    let canceled = false;
    const stream = new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('{')); },
      cancel() { canceled = true; },
    });
    const operation = local ? readManifestFile({ size: 1, stream: () => stream }, { timeoutMs: 20 })
      : readManifestJSON(url, async () => new Response(stream), { timeoutMs: 20 });
    await assert.rejects(operation, /超时/); assert.equal(canceled, true);
  }
});

class Element {
  constructor(tagName) {
    this.tagName = tagName; this.children = []; this.listeners = {}; this.disabled = false;
    this.value = ''; this.textContent = ''; this.files = []; this.classList = { toggle() {} };
  }
  append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  setAttribute(name, value) { this[name] = value; }
  addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); }
  async emit(name) { await Promise.all((this.listeners[name] || []).map(callback => callback({ target: this }))); }
  closest(tagName) { let node = this; while (node && node.tagName !== tagName) node = node.parent; return node; }
}

function ui(fetcher = () => assert.fail('unexpected automatic fetch')) {
  const nodes = Object.fromEntries(['onlineGameList', 'onlineManifestStatus', 'onlineManifestFile', 'onlineManifestURL', 'onlineManifestLoadBtn']
    .map(id => [id, new Element(id === 'onlineManifestLoadBtn' ? 'button' : 'div')]));
  new Element('label').append(nodes.onlineManifestFile);
  const instances = [], played = [], errors = [];
  class Download {
    constructor(manifest, options) { this.manifest = manifest; this.options = options; instances.push(this); }
    subscribe(listener) { this.listener = listener; listener({ verifiedBytes: 0, total: this.manifest.size }); return () => { this.unsubscribed = true; }; }
    start() { this.operation = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; }); return this.operation; }
    pause() { this.pauseCalled = true; return this.operation; }
  }
  initOnlineGames({ root: { getElementById: id => nodes[id], createElement: tag => new Element(tag) }, fetcher, Download,
    canPlay: () => true, play: file => played.push(file), reportError: message => errors.push(message) });
  return { nodes, instances, played, errors,
    card: () => nodes.onlineGameList.children[0],
    actions: () => nodes.onlineGameList.children[0].children.at(-1).children,
    select: () => nodes.onlineGameList.children[0].children[2].children[1],
    import: async manifest => { nodes.onlineManifestFile.files = [jsonFile(manifest)]; nodes.onlineManifestFile.value = 'manifest.json'; await nodes.onlineManifestFile.emit('change'); },
  };
}

test('initialization is offline and local import previews a validated manifest without starting download', async () => {
  const app = ui();
  assert.equal(app.nodes.onlineGameList.children.length, 0); assert.equal(app.instances.length, 0);
  await app.import(valid());
  assert.equal(app.card().children[0].textContent, '测试游戏.iso');
  assert.match(app.card().children[1].textContent, /64 KB.*2 条/);
  assert.equal(app.select().children.length, 2); assert.match(app.select().children[1].textContent, /mirror.example/);
  assert.equal(app.instances.length, 0); assert.equal(app.nodes.onlineManifestFile.value, '');
});

test('explicit download reorders mirrors and derives worker origins from the imported manifest', async () => {
  const app = ui(); await app.import(valid()); app.select().value = '1';
  const operation = app.actions()[0].emit('click');
  const task = app.instances[0];
  assert.deepEqual(task.manifest.sources, valid().sources.toReversed());
  assert.deepEqual(task.options.allowedOrigins, ['https://download.example', 'https://mirror.example']);
  assert.equal(app.nodes.onlineManifestLoadBtn.disabled, true);
  const file = new File(['data'], valid().name);
  task.resolve({ file }); await operation;
  await app.actions()[2].emit('click'); assert.equal(app.played[0], file);
  assert.equal(app.actions()[0].textContent, '读取已下载游戏');
  assert.equal(app.nodes.onlineManifestLoadBtn.disabled, false);
});

test('imports cannot replace a downloading or pausing card until the worker acknowledges pause', async () => {
  const app = ui(); await app.import(valid()); const card = app.card();
  const operation = app.actions()[0].emit('click'); const task = app.instances[0];
  await app.import(valid('other.iso')); assert.equal(app.card(), card);
  const pausing = app.actions()[1].emit('click');
  assert.equal(task.pauseCalled, true); assert.equal(app.nodes.onlineManifestFile.disabled, true);
  await app.import(valid('other.iso')); assert.equal(app.card(), card);
  task.resolve(null); await Promise.all([operation, pausing]);
  assert.equal(app.nodes.onlineManifestFile.disabled, false);
  await app.import(valid('other.iso')); assert.notEqual(app.card(), card); assert.equal(task.unsubscribed, true);
});

test('failed local/URL imports retain the current card and can be retried', async () => {
  let fails = true;
  const app = ui(async () => { if (fails) throw new Error('network'); return new Response(JSON.stringify(valid('replacement.iso'))); });
  await app.import(valid()); const card = app.card();
  await app.import({ ...valid(), sha256: [] });
  assert.equal(app.card(), card); assert.match(app.nodes.onlineManifestStatus.textContent, /失败/);
  assert.equal(app.nodes.onlineManifestFile.value, '');
  app.nodes.onlineManifestURL.value = url;
  await app.nodes.onlineManifestLoadBtn.emit('click');
  assert.equal(app.card(), card); assert.equal(app.nodes.onlineManifestLoadBtn.disabled, false);
  fails = false; await app.nodes.onlineManifestLoadBtn.emit('click');
  assert.equal(app.card().children[0].textContent, 'replacement.iso');
});

test('a pending import locks existing card actions and duplicate loads without discarding the card', async () => {
  let resolve, calls = 0;
  const app = ui(() => { calls++; return new Promise(done => { resolve = done; }); });
  await app.import(valid()); const card = app.card(); app.nodes.onlineManifestURL.value = url;
  const loading = app.nodes.onlineManifestLoadBtn.emit('click'); await tick();
  assert.equal(app.card(), card); assert.equal(app.actions()[0].disabled, true);
  await app.actions()[0].emit('click'); await app.nodes.onlineManifestLoadBtn.emit('click');
  assert.equal(app.instances.length, 0); assert.equal(calls, 1);
  resolve(new Response(JSON.stringify(valid('replacement.iso')))); await loading;
  assert.equal(app.card().children[0].textContent, 'replacement.iso'); assert.equal(app.actions()[0].disabled, false);
});

test('download failures release import controls and allow a new download attempt', async () => {
  const app = ui(); await app.import(valid());
  const failed = app.actions()[0].emit('click'); app.instances[0].reject(new Error('try again')); await failed;
  assert.equal(app.nodes.onlineManifestFile.disabled, false); assert.equal(app.actions()[0].disabled, false);
  const retry = app.actions()[0].emit('click'); assert.equal(app.instances.length, 2);
  app.instances[1].resolve(null); await retry;
});
