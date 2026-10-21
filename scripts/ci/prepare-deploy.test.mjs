import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { edgeoneConfig, fetchMetadata, prepareDeployment, validateDeployConfig, verifyStaticOutput } from './prepare-deploy.mjs';
import { verifyDeployment } from './verify-deployment.mjs';

async function fixture(t) {
  const output = await mkdtemp(join(tmpdir(), 'player-ci-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  const revision = 'a'.repeat(64);
  for (const name of ['index.html', 'download-worker.js', 'browser-files.js', 'ppsspp-runtime.js', 'build-wasm/PPSSPPSDL.js', 'build-wasm/PPSSPPSDL.wasm', 'build-wasm/PPSSPPSDL.data']) {
    await mkdir(dirname(join(output, name)), { recursive: true });
    await writeFile(join(output, name), 'fixture');
  }
  await writeFile(join(output, 'build-info.json'), JSON.stringify({ revision }));
  const manifest = { schemaVersion: 1, id: 'chs', name: 'game.iso', size: 65536, chunkSize: 65536,
    sha256: ['b'.repeat(64)], sources: ['https://cdn.example/game.iso'] };
  const bytes = Buffer.from(JSON.stringify(manifest));
  const config = { schemaVersion: 1, allowedOrigins: ['https://cdn.example'],
    games: [{ title: '中文版', manifestUrl: 'https://cdn.example/game.json', manifestSha256: createHash('sha256').update(bytes).digest('hex') }] };
  return { output, revision, manifest, bytes, config };
}

test('production config accepts only exact HTTPS origins and pinned JSON metadata', async t => {
  const { config } = await fixture(t);
  assert.equal(validateDeployConfig(config).games.length, 1);
  for (const change of [{ allowedOrigins: ['*'] }, { allowedOrigins: ['http://cdn.example'] }, { allowedOrigins: ['https://cdn.example/path'] }, { games: [] }]) {
    assert.throws(() => validateDeployConfig({ ...config, ...change }));
  }
  for (const change of [{ manifestUrl: 'https://other.example/file.json' }, { manifestUrl: 'https://cdn.example/game.iso' }, { manifestUrl: 'https://user:pass@cdn.example/game.json' }, { manifestSha256: '' }]) {
    assert.throws(() => validateDeployConfig({ ...config, games: [{ ...config.games[0], ...change }] }));
  }
});

test('deployment prepares catalog and headers by fetching metadata only, never ISO content', async t => {
  const { output, config, bytes } = await fixture(t);
  const calls = [];
  await prepareDeployment(config, { output, fetcher: async (url, options) => {
    calls.push(url);
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
    return new Response(bytes);
  } });
  assert.deepEqual(calls, ['https://cdn.example/game.json']);
  const catalog = JSON.parse(await readFile(join(output, 'game-catalog.json'), 'utf8'));
  assert.deepEqual(catalog.games, [{ title: '中文版', manifest: 'game-manifests/chs.json' }]);
  assert.deepEqual(JSON.parse(await readFile(join(output, 'edgeone.json'), 'utf8')), edgeoneConfig(config.allowedOrigins));
  await verifyStaticOutput(output);
});

test('a changed metadata digest or unapproved download source leaves existing output unchanged', async t => {
  const { output, config, bytes, manifest } = await fixture(t);
  await writeFile(join(output, 'game-catalog.json'), 'original');
  await assert.rejects(prepareDeployment(config, { output, fetcher: async () => new Response(Buffer.concat([bytes, Buffer.from('\n')])) }));
  assert.equal(await readFile(join(output, 'game-catalog.json'), 'utf8'), 'original');
  const changed = Buffer.from(JSON.stringify({ ...manifest, sources: ['https://other.example/game.iso'] }));
  const adjusted = { ...config, games: [{ ...config.games[0], manifestSha256: createHash('sha256').update(changed).digest('hex') }] };
  await assert.rejects(prepareDeployment(adjusted, { output, fetcher: async () => new Response(changed) }));
  assert.equal(await readFile(join(output, 'game-catalog.json'), 'utf8'), 'original');
});

test('metadata size limits cancel the stream instead of reading an arbitrary asset', async () => {
  let cancelled = false;
  const fetcher = async () => new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)); }, cancel() { cancelled = true; } }));
  await assert.rejects(fetchMetadata('https://cdn.example/game.json', fetcher));
  assert.equal(cancelled, true);
});

test('reconfiguration removes stale generated manifests from the publish directory', async t => {
  const { output, config, bytes } = await fixture(t);
  await mkdir(join(output, 'game-manifests'));
  await writeFile(join(output, 'game-manifests/obsolete.json'), '{}');
  await prepareDeployment(config, { output, fetcher: async () => new Response(bytes) });
  assert.deepEqual(await readdir(join(output, 'game-manifests')), ['chs.json']);
});

test('static output verification rejects accidental game packages and mismatched CSP', async t => {
  const { output, config, bytes } = await fixture(t);
  await prepareDeployment(config, { output, fetcher: async () => new Response(bytes) });
  await writeFile(join(output, 'mistake.iso'), 'not-for-publish');
  await assert.rejects(verifyStaticOutput(output));
  await rm(join(output, 'mistake.iso'));
  await writeFile(join(output, 'edgeone.json'), JSON.stringify(edgeoneConfig([])));
  await assert.rejects(verifyStaticOutput(output));
});

test('production verification checks current revision and actual host isolation headers', async t => {
  const { output, config, bytes, revision } = await fixture(t);
  await prepareDeployment(config, { output, fetcher: async () => new Response(bytes) });
  const buildInfo = JSON.parse(await readFile(join(output, 'build-info.json'), 'utf8'));
  const configured = Object.fromEntries(edgeoneConfig(config.allowedOrigins).headers[0].headers.map(({ key, value }) => [key, value]));
  const request = async (url, options) => {
    assert.equal(options.redirect, 'error');
    if (url.includes('build-info.json')) return new Response(JSON.stringify(buildInfo));
    assert.equal(options.method, 'HEAD');
    return new Response(null, { headers: { ...configured, 'Content-Type': 'application/wasm' } });
  };
  await verifyDeployment('https://player.example', { output, fetcher: request });
  await assert.rejects(verifyDeployment('https://player.example', { output, fetcher: async (url, options) => {
    if (url.includes('build-info.json')) return new Response(JSON.stringify({ revision: 'old' }));
    return request(url, options);
  } }));
  await assert.rejects(verifyDeployment('https://player.example', { output, fetcher: async (url, options) => {
    if (url.includes('build-info.json')) return new Response(JSON.stringify({ revision, deploymentRevision: '0'.repeat(64) }));
    return request(url, options);
  } }));
  await assert.rejects(verifyDeployment('https://player.example', { output, fetcher: async (url, options) => {
    if (url.includes('build-info.json')) return request(url, options);
    return new Response(null, { headers: { ...configured, 'Cross-Origin-Embedder-Policy': 'unsafe-none' } });
  } }));
});

test('preparing a new deployment changes its identity even when the emulator core is unchanged', async t => {
  const { output, config, bytes, revision } = await fixture(t);
  const options = { output, fetcher: async () => new Response(bytes) };
  await prepareDeployment(config, options);
  const previous = JSON.parse(await readFile(join(output, 'build-info.json'), 'utf8'));
  await writeFile(join(output, 'index.html'), 'updated web page');
  await prepareDeployment(config, options);
  const current = JSON.parse(await readFile(join(output, 'build-info.json'), 'utf8'));
  assert.equal(current.revision, revision);
  assert.match(current.deploymentRevision, /^[a-f0-9]{64}$/);
  assert.notEqual(current.deploymentRevision, previous.deploymentRevision);
});
