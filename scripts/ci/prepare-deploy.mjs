import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateManifest } from '../../wasm-page/public/game-download.js';

export const OUTPUT = fileURLToPath(new URL('../../wasm-page/dist/ppsspp-web/', import.meta.url));
const LIMIT = 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/i;
const json = value => JSON.stringify(value, null, 2) + '\n';
const error = message => { throw new Error(message); };

export function httpsOrigin(value) {
  let url;
  try { url = new URL(value); } catch { error('部署来源配置无效'); }
  if (typeof value !== 'string' || url.protocol !== 'https:' || url.origin !== value || url.username || url.password || /[\s\\]/.test(value)) error('部署来源必须为精确的 HTTPS origin');
  return url.origin;
}

export function validateDeployConfig(input) {
  if (input?.schemaVersion !== 1 || !Array.isArray(input.games) || input.games.length < 1 || input.games.length > 16
      || !Array.isArray(input.allowedOrigins) || input.allowedOrigins.length < 1 || input.allowedOrigins.length > 8) error('部署配置格式无效或没有游戏条目');
  const allowedOrigins = [...new Set(input.allowedOrigins.map(httpsOrigin))];
  const games = input.games.map(game => {
    if (typeof game?.title !== 'string' || !game.title.trim() || game.title.length > 120
        || typeof game.manifestSha256 !== 'string' || !SHA256.test(game.manifestSha256)) error('游戏条目缺少标题或清单 SHA256');
    let url;
    try { url = new URL(game.manifestUrl); } catch { error('清单地址无效'); }
    if (typeof game.manifestUrl !== 'string' || /[\s\\]/.test(game.manifestUrl) || url.protocol !== 'https:' || url.username || url.password || url.hash
        || !allowedOrigins.includes(url.origin) || !url.pathname.toLowerCase().endsWith('.json')) error('清单必须为允许来源上的 HTTPS JSON 文件');
    return { title: game.title.trim(), manifestUrl: url.href, manifestSha256: game.manifestSha256.toLowerCase() };
  });
  return { schemaVersion: 1, allowedOrigins, games };
}

export async function readLimitedBody(response, limit = LIMIT) {
  if (!response.ok || !response.body) error('无法取得部署所需的清单元数据');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) error('清单元数据超出大小限制');
      chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } finally { await reader.cancel().catch(() => {}); }
}

export async function fetchMetadata(url, fetcher = fetch) {
  const response = await fetcher(url, { redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(30000), headers: { Accept: 'application/json' } });
  return readLimitedBody(response);
}

export function edgeoneConfig(allowedOrigins) {
  const connections = ["'self'", 'blob:', ...allowedOrigins.map(httpsOrigin)].join(' ');
  const headers = {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Security-Policy': `connect-src ${connections}; worker-src 'self' blob:; form-action 'none'; frame-src 'none'; object-src 'none'; base-uri 'self'`,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
  };
  if (Object.values(headers).some(value => value.length > 1000 || /[^\x20-\x7e]/.test(value))) error('响应头超出静态宿主限制');
  return { headers: [
    { source: '/*', headers: Object.entries(headers).map(([key, value]) => ({ key, value })) },
    { source: '/build-wasm/*.wasm', headers: [{ key: 'Content-Type', value: 'application/wasm' }] },
  ] };
}

async function stampDeployment(output) {
  const path = join(output, 'build-info.json');
  const build = JSON.parse(await readFile(path, 'utf8'));
  if (!SHA256.test(build.revision || '')) error('模拟器构建标识无效');
  // The core hash can stay unchanged when only the web page or catalog changes.
  await writeFile(path, json({ ...build, deploymentRevision: randomBytes(32).toString('hex') }));
}

export async function prepareDeployment(input, { output = OUTPUT, fetcher = fetch } = {}) {
  const config = validateDeployConfig(input);
  // Resolve and validate every input before replacing any packaged configuration.
  const manifests = [];
  const ids = new Set();
  for (const game of config.games) {
    const data = await fetchMetadata(game.manifestUrl, fetcher);
    if (createHash('sha256').update(data).digest('hex') !== game.manifestSha256) error('清单 SHA256 与受控配置不一致');
    let inputManifest;
    try { inputManifest = JSON.parse(data); } catch { error('清单不是有效的 JSON'); }
    const manifest = validateManifest(inputManifest, { allowedOrigins: config.allowedOrigins });
    if (ids.has(manifest.id)) error('游戏清单标识重复');
    ids.add(manifest.id);
    manifests.push({ title: game.title, manifest });
  }
  const headers = edgeoneConfig(config.allowedOrigins);
  const manifestDirectory = join(output, 'game-manifests');
  await mkdir(manifestDirectory, { recursive: true });
  if ((await lstat(manifestDirectory)).isSymbolicLink()) error('清单输出目录不能是符号链接');
  const old = await readdir(manifestDirectory, { withFileTypes: true });
  if (old.some(entry => !entry.isFile() || !entry.name.endsWith('.json'))) error('清单输出目录包含非生成文件');
  for (const entry of old) await unlink(join(manifestDirectory, entry.name));
  for (const entry of manifests) await writeFile(join(output, 'game-manifests', entry.manifest.id + '.json'), json(entry.manifest));
  const catalog = { schemaVersion: 1, allowedOrigins: config.allowedOrigins,
    games: manifests.map(entry => ({ title: entry.title, manifest: 'game-manifests/' + entry.manifest.id + '.json' })) };
  await writeFile(join(output, 'game-catalog.json'), json(catalog));
  await writeFile(join(output, 'edgeone.json'), json(headers));
  await stampDeployment(output);
  return catalog;
}

export async function verifyStaticOutput(output = OUTPUT) {
  for (const name of ['index.html', 'download-worker.js', 'browser-files.js', 'ppsspp-runtime.js', 'build-info.json', 'build-wasm/PPSSPPSDL.js', 'build-wasm/PPSSPPSDL.wasm', 'build-wasm/PPSSPPSDL.data']) {
    if (!(await stat(join(output, name))).isFile()) error('静态产物不完整');
  }
  const build = JSON.parse(await readFile(join(output, 'build-info.json'), 'utf8'));
  if (!SHA256.test(build.revision || '') || !SHA256.test(build.deploymentRevision || '')) error('构建或部署标识无效');
  const catalog = JSON.parse(await readFile(join(output, 'game-catalog.json'), 'utf8'));
  const expected = edgeoneConfig(catalog.allowedOrigins);
  if (JSON.stringify(JSON.parse(await readFile(join(output, 'edgeone.json'), 'utf8'))) !== JSON.stringify(expected)) error('静态宿主响应头与游戏来源白名单不一致');
  const visit = async path => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || /\.(?:iso|cso|chd|pbp|zip|7z|rar)$/i.test(entry.name)
          || ['resources', 'node_modules', '.git', '.env'].includes(entry.name)) error('部署产物包含禁止分发的本地输入');
      if (entry.isDirectory()) await visit(join(path, entry.name));
    }
  };
  await visit(output);
}

async function main() {
  if (process.argv.includes('--empty')) {
    await writeFile(join(OUTPUT, 'game-catalog.json'), json({ schemaVersion: 1, allowedOrigins: [], games: [] }));
    await writeFile(join(OUTPUT, 'edgeone.json'), json(edgeoneConfig([])));
    await stampDeployment(OUTPUT);
  } else {
    const raw = process.env.PLAYER_DEPLOY_CONFIG_JSON;
    if (!raw || Buffer.byteLength(raw) > 100 * 1024) error('缺少有效的部署配置注入');
    httpsOrigin(process.env.PLAYER_PUBLIC_ORIGIN);
    let config;
    try { config = JSON.parse(raw); } catch { error('部署配置不是有效的 JSON'); }
    await prepareDeployment(config);
  }
  await verifyStaticOutput();
  console.log('静态产物、游戏清单与宿主响应头配置验证通过。');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('部署准备失败：请核对受控配置、清单元数据和完整构建产物。具体配置值不会写入日志。'); process.exitCode = 1; });
}
