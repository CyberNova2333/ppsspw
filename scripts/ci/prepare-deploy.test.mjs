import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { edgeoneConfig, httpsOrigin, prepareDeployment, verifyStaticOutput } from './prepare-deploy.mjs';
import { verifyDeployment } from './verify-deployment.mjs';

async function fixture(t) {
  const output = await mkdtemp(join(tmpdir(), 'player-ci-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  const revision = 'a'.repeat(64);
  for (const name of ['index.html', 'download-worker.js', 'game-download.js', 'online-games.js', 'browser-files.js', 'browser-storage.js', 'ppsspp-runtime.js', 'build-wasm/PPSSPPSDL.js', 'build-wasm/PPSSPPSDL.wasm', 'build-wasm/PPSSPPSDL.data']) {
    await mkdir(dirname(join(output, name)), { recursive: true });
    await writeFile(join(output, name), 'fixture');
  }
  await writeFile(join(output, 'build-info.json'), JSON.stringify({ revision }));
  return { output, revision };
}

test('build preparation uses no download configuration or network and permits runtime HTTPS sources', async t => {
  const { output } = await fixture(t);
  t.mock.method(globalThis, 'fetch', () => { throw new Error('build preparation must stay offline'); });
  const previous = process.env.PLAYER_DEPLOY_CONFIG_JSON;
  process.env.PLAYER_DEPLOY_CONFIG_JSON = 'obsolete configuration must not be consumed';
  t.after(() => {
    if (previous === undefined) delete process.env.PLAYER_DEPLOY_CONFIG_JSON;
    else process.env.PLAYER_DEPLOY_CONFIG_JSON = previous;
  });
  await prepareDeployment({ output });
  const headers = JSON.parse(await readFile(join(output, 'edgeone.json'), 'utf8'));
  const policy = headers.headers[0].headers.find(({ key }) => key === 'Content-Security-Policy').value;
  assert.match(policy, /^connect-src 'self' blob: https:;/);
  assert.doesNotMatch(policy, /https:\/\//);
  assert.equal((await readdir(output)).includes('game-catalog.json'), false);
  assert.equal((await readdir(output)).includes('game-manifests'), false);
  await verifyStaticOutput(output);
});

test('preparation removes legacy generated catalogs and manifests from reused output', async t => {
  const { output } = await fixture(t);
  await mkdir(join(output, 'game-manifests'));
  await writeFile(join(output, 'game-manifests/obsolete.json'), '{"sources":["https://old.example/game.iso"]}');
  await writeFile(join(output, 'game-catalog.json'), '{"allowedOrigins":["https://old.example"]}');
  await prepareDeployment({ output });
  assert.equal((await readdir(output)).includes('game-catalog.json'), false);
  assert.equal((await readdir(output)).includes('game-manifests'), false);
  assert.doesNotMatch(await readFile(join(output, 'edgeone.json'), 'utf8'), /old\.example/);
});

test('legacy cleanup rejects unknown contents without deleting them', async t => {
  const { output } = await fixture(t);
  await mkdir(join(output, 'game-manifests'));
  await writeFile(join(output, 'game-manifests/unexpected.txt'), 'preserve');
  await assert.rejects(prepareDeployment({ output }));
  assert.equal(await readFile(join(output, 'game-manifests/unexpected.txt'), 'utf8'), 'preserve');
});

test('public deployment validation accepts only exact HTTPS origins', () => {
  assert.equal(httpsOrigin('https://player.example'), 'https://player.example');
  for (const origin of ['http://player.example', 'https://player.example/path', 'https://user:pass@player.example', '*', undefined]) {
    assert.throws(() => httpsOrigin(origin));
  }
});

test('static output verification rejects game packages, fixed catalogs, missing runtime, and changed CSP', async t => {
  const { output } = await fixture(t);
  await prepareDeployment({ output });
  for (const name of ['mistake.iso', 'game-catalog.json']) {
    await writeFile(join(output, name), 'not-for-publish');
    await assert.rejects(verifyStaticOutput(output));
    await rm(join(output, name));
  }
  await rm(join(output, 'game-download.js'));
  await assert.rejects(verifyStaticOutput(output));
  await writeFile(join(output, 'game-download.js'), 'fixture');
  const headers = edgeoneConfig();
  headers.headers[0].headers.find(({ key }) => key === 'Content-Security-Policy').value = "connect-src 'self'";
  await writeFile(join(output, 'edgeone.json'), JSON.stringify(headers));
  await assert.rejects(verifyStaticOutput(output));
});

test('production verification checks this deployment and isolation headers without a game catalog', async t => {
  const { output, revision } = await fixture(t);
  await prepareDeployment({ output });
  const buildInfo = JSON.parse(await readFile(join(output, 'build-info.json'), 'utf8'));
  const configured = Object.fromEntries(edgeoneConfig().headers[0].headers.map(({ key, value }) => [key, value]));
  const request = async (url, options) => {
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
    assert.equal(new URL(url).origin, 'https://player.example');
    if (url.includes('build-info.json')) return new Response(JSON.stringify(buildInfo));
    assert.equal(options.method, 'HEAD');
    return new Response(null, { headers: { ...configured, 'Content-Type': 'application/wasm' } });
  };
  await verifyDeployment('https://player.example', { output, fetcher: request });
  await assert.rejects(verifyDeployment('https://player.example', { output, fetcher: async (url, options) => {
    if (url.includes('build-info.json')) return new Response(JSON.stringify({ revision: 'old', deploymentRevision: buildInfo.deploymentRevision }));
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

test('online version response limits cancel an oversized stream', async t => {
  const { output } = await fixture(t);
  await prepareDeployment({ output });
  let cancelled = false;
  const fetcher = async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(65537)); },
    cancel() { cancelled = true; },
  }));
  await assert.rejects(verifyDeployment('https://player.example', { output, fetcher }));
  assert.equal(cancelled, true);
});

test('a new deployment changes its identity even when the emulator core is unchanged', async t => {
  const { output, revision } = await fixture(t);
  await prepareDeployment({ output });
  const previous = JSON.parse(await readFile(join(output, 'build-info.json'), 'utf8'));
  await writeFile(join(output, 'index.html'), 'updated web page');
  await prepareDeployment({ output });
  const current = JSON.parse(await readFile(join(output, 'build-info.json'), 'utf8'));
  assert.equal(current.revision, revision);
  assert.match(current.deploymentRevision, /^[a-f0-9]{64}$/);
  assert.notEqual(current.deploymentRevision, previous.deploymentRevision);
});
