import { GameDownload, validateManifest } from './game-download.js';

const MANIFEST_LIMIT = 1024 * 1024;

export function validateManifestURL(value) {
  let url;
  try {
    if (typeof value !== 'string' || /[\s\\\u0000-\u001f\u007f]/.test(value)) throw new Error();
    url = new URL(value);
  } catch { throw new Error('请输入完整的 HTTPS 清单地址'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || value.includes('#')) {
    throw new Error('清单地址须使用 HTTPS，且不能包含登录凭证或片段');
  }
  return url.href;
}

async function readBoundedJSON(open, { timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  let reader, timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error('清单读取超时，请重试');
      controller.abort(error);
      void reader?.cancel(error).catch(() => {});
      reject(error);
    }, timeoutMs);
  });
  const read = async () => {
    const body = await open(controller.signal);
    if (controller.signal.aborted) { void body?.cancel().catch(() => {}); throw controller.signal.reason; }
    if (!body) throw new Error('浏览器无法读取清单');
    reader = body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let text = '', size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (controller.signal.aborted) throw controller.signal.reason;
      if (done) break;
      size += value.byteLength;
      if (size > MANIFEST_LIMIT) throw new Error('清单文件不能超过 1 MiB');
      try { text += decoder.decode(value, { stream: true }); }
      catch { throw new Error('清单须为 UTF-8 编码的 JSON 文件'); }
    }
    try { return JSON.parse(text + decoder.decode()); }
    catch { throw new Error('清单不是有效的 JSON 文件'); }
  };
  try {
    return await Promise.race([read(), deadline]);
  } finally { clearTimeout(timer); controller.abort(); void reader?.cancel().catch(() => {}); }
}

export async function readManifestJSON(value, fetcher = fetch, options) {
  const url = validateManifestURL(value);
  return readBoundedJSON(async signal => {
    let response;
    try { response = await fetcher(url, { mode: 'cors', cache: 'no-store', credentials: 'omit', redirect: 'error', signal }); }
    catch (error) { if (signal.aborted) throw signal.reason; throw new Error('无法读取清单，请检查地址、网络和跨域访问设置'); }
    if (!response.ok || response.redirected || Number(response.headers.get('Content-Length')) > MANIFEST_LIMIT) {
      void response.body?.cancel().catch(() => {});
      if (!response.ok) throw new Error(`清单读取失败（HTTP ${response.status}）`);
      if (response.redirected) throw new Error('清单地址不能跳转，请使用最终地址');
      throw new Error('清单文件不能超过 1 MiB');
    }
    return response.body;
  }, options);
}

export async function readManifestFile(file, options) {
  if (!file || !Number.isSafeInteger(file.size) || file.size < 1) throw new Error('请选择非空的 JSON 清单文件');
  if (file.size > MANIFEST_LIMIT) throw new Error('清单文件不能超过 1 MiB');
  return readBoundedJSON(() => file.stream(), options);
}

function bytes(value) {
  if (value >= 1024 ** 3) return (value / 1024 ** 3).toFixed(2) + ' GB';
  if (value >= 1024 ** 2) return (value / 1024 ** 2).toFixed(1) + ' MB';
  return Math.round(value / 1024) + ' KB';
}

// Downloaded files remain in the engine's OPFS cache. The player receives a
// File reference; copying them into the separate local library would double disk usage.
export function initOnlineGames({ play, canPlay, reportError, root = document, fetcher = fetch, Download = GameDownload }) {
  const list = root.getElementById('onlineGameList');
  const status = root.getElementById('onlineManifestStatus');
  const fileInput = root.getElementById('onlineManifestFile');
  const urlInput = root.getElementById('onlineManifestURL');
  const loadButton = root.getElementById('onlineManifestLoadBtn');
  if (!list || !status || !fileInput || !urlInput || !loadButton) return;
  let loading = false;
  let current = null;
  const updateControls = () => {
    const busy = loading || !!current?.busy;
    fileInput.disabled = busy; urlInput.disabled = busy; loadButton.disabled = busy;
    fileInput.closest('label')?.classList.toggle('disabled', busy);
    current?.updateControls();
  };

  function createEntry(manifest) {
    const allowedOrigins = [...new Set(manifest.sources.map(value => new URL(value).origin))];
    const card = root.createElement('section');
    card.className = 'online-game-card';
    const heading = root.createElement('h3'); heading.textContent = manifest.name;
    const size = root.createElement('p'); size.textContent = `${bytes(manifest.size)} · ${manifest.sources.length} 条下载线路`;
    const lineLabel = root.createElement('label'); lineLabel.className = 'setting-field';
    const lineText = root.createElement('span'); lineText.textContent = '下载线路';
    const source = root.createElement('select'); source.setAttribute('aria-label', `${manifest.name}的下载线路`);
    manifest.sources.forEach((value, index) => {
      const option = root.createElement('option'); option.value = String(index); option.textContent = `线路 ${index + 1} · ${new URL(value).hostname}`; source.append(option);
    });
    lineLabel.append(lineText, source);
    const progress = root.createElement('progress'); progress.max = manifest.size; progress.value = 0;
    progress.setAttribute('aria-label', `${manifest.name}已校验的下载进度`);
    const detail = root.createElement('p'); detail.className = 'online-download-status'; detail.setAttribute('role', 'status');
    detail.textContent = '下载会保存在当前浏览器中，可以暂停后继续。';
    const actions = root.createElement('div'); actions.className = 'player-actions';
    const download = root.createElement('button'); download.textContent = '下载或继续'; download.type = 'button';
    const pause = root.createElement('button'); pause.textContent = '暂停'; pause.type = 'button'; pause.disabled = true;
    const launch = root.createElement('button'); launch.textContent = '开始游玩'; launch.type = 'button'; launch.className = 'primary'; launch.disabled = true;
    actions.append(download, pause, launch); card.append(heading, size, lineLabel, progress, detail, actions);
    const entry = { card, busy: false, file: null, task: null, updateControls: () => {
      download.disabled = entry.busy || loading; source.disabled = entry.busy || loading;
      pause.disabled = !entry.busy; launch.disabled = entry.busy || loading || !entry.file;
    } };
    let unsubscribe;
    const setBusy = value => {
      entry.busy = value; updateControls();
    };
    download.addEventListener('click', async () => {
      if (entry.busy || loading || current !== entry) return;
      setBusy(true);
      const index = Math.max(0, Math.min(manifest.sources.length - 1, Number(source.value) || 0));
      const sources = [manifest.sources[index], ...manifest.sources.filter((_, i) => i !== index)];
      unsubscribe?.();
      try {
        entry.task = new Download({ ...manifest, sources }, { concurrency: 2, maxRetries: 3, allowedOrigins });
        unsubscribe = entry.task.subscribe(state => {
          progress.value = state.verifiedBytes;
          const speed = state.speedBytesPerSecond > 0 ? ` · ${bytes(state.speedBytesPerSecond)}/秒` : '';
          detail.textContent = `${state.message || ''} ${bytes(state.verifiedBytes)} / ${bytes(state.total)}${speed}`;
        });
        const result = await entry.task.start();
        if (result) {
          entry.file = result.file;
          detail.textContent = '下载与校验完成，可以开始游玩。'; download.textContent = '读取已下载游戏';
        } else detail.textContent = '已暂停。可以切换线路，或稍后继续下载。';
      } catch (error) {
        entry.file = null; detail.textContent = `下载未完成：${error.message}`;
      } finally { setBusy(false); }
    });
    pause.addEventListener('click', async () => {
      if (!entry.busy || current !== entry) return;
      pause.disabled = true; detail.textContent = '正在暂停，已校验的进度会保留…';
      try { await entry.task?.pause(); }
      catch (error) { detail.textContent = `暂停失败：${error.message}`; }
    });
    launch.addEventListener('click', () => {
      if (loading || entry.busy || current !== entry) return;
      if (!canPlay()) { reportError('模拟器已经启动。请先保存并同步进度，再重新载入页面切换游戏。'); return; }
      if (entry.file) play(entry.file);
    });
    entry.dispose = () => unsubscribe?.();
    return entry;
  }

  async function load(read) {
    if (loading || current?.busy) return;
    loading = true; updateControls();
    status.textContent = '正在读取下载清单…';
    try {
      const manifest = validateManifest(await read());
      const next = createEntry(manifest);
      current?.dispose(); current = next; list.replaceChildren(next.card);
      status.textContent = '清单已载入。确认文件和线路后，点击“下载或继续”。';
    } catch (error) { status.textContent = `清单载入失败：${error.message}`; }
    finally { loading = false; fileInput.value = ''; updateControls(); }
  }
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) return load(() => readManifestFile(file));
  });
  loadButton.addEventListener('click', () => load(() => readManifestJSON(urlInput.value.trim(), fetcher)));
  updateControls();
}
