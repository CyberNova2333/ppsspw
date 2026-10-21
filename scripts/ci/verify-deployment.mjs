import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OUTPUT, edgeoneConfig, httpsOrigin } from './prepare-deploy.mjs';

async function readBuildInfo(response) {
  if (!response.ok || !response.body) throw new Error('部署版本响应无效');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65536) throw new Error('部署版本响应超出大小限制');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks, size));
  } finally { await reader.cancel().catch(() => {}); }
}

export async function verifyDeployment(origin, { output = OUTPUT, fetcher = fetch } = {}) {
  httpsOrigin(origin);
  const expectedBuild = JSON.parse(await readFile(join(output, 'build-info.json'), 'utf8'));
  const expectedHeaders = edgeoneConfig().headers[0].headers;
  const request = (path, method) => fetcher(origin + path, { method, redirect: 'error', cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(30000) });
  if (!/^[a-f0-9]{64}$/.test(expectedBuild.deploymentRevision || '')) throw new Error('缺少本次部署标识');
  const revision = await request('/build-info.json?verify=' + expectedBuild.deploymentRevision, 'GET');
  if (!revision.ok || Number(revision.headers.get('Content-Length') || 0) > 65536) throw new Error('部署版本响应无效');
  const publishedBuild = await readBuildInfo(revision);
  if (publishedBuild.revision !== expectedBuild.revision || publishedBuild.deploymentRevision !== expectedBuild.deploymentRevision) throw new Error('线上尚未提供当前部署');
  for (const path of ['/', '/download-worker.js', '/build-wasm/PPSSPPSDL.js', '/build-wasm/PPSSPPSDL.wasm']) {
    const response = await request(path, 'HEAD');
    if (!response.ok) throw new Error('部署后的静态资源不可访问');
    for (const { key, value } of expectedHeaders) {
      if (response.headers.get(key)?.trim() !== value) throw new Error('线上浏览器隔离或下载来源响应头未生效');
    }
    if (path.endsWith('.wasm') && response.headers.get('Content-Type')?.split(';')[0] !== 'application/wasm') throw new Error('线上 Wasm MIME 配置无效');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifyDeployment(process.env.PLAYER_PUBLIC_ORIGIN)
    .then(() => console.log('线上构建版本、COOP、COEP、CSP 与 Wasm MIME 验证通过。'))
    .catch(() => { console.error('线上验证失败：当前版本或浏览器隔离响应头尚未生效。未输出站点地址或私有配置。'); process.exitCode = 1; });
}
