import { GameDownload, validateManifest } from './game-download.js';

const CATALOG_LIMIT = 1024 * 1024;

export async function readCatalogJSON(url, fetcher = fetch, { timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  let reader, timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error('游戏列表读取超时，请检查网络后刷新列表重试');
      controller.abort(error);
      void reader?.cancel(error).catch(() => {});
      reject(error);
    }, timeoutMs);
  });
  const read = async () => {
    const response = await fetcher(url, { cache: 'no-store', credentials: 'same-origin', redirect: 'error', signal: controller.signal });
    if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); throw controller.signal.reason; }
    if (!response.ok) throw new Error(`游戏列表读取失败（HTTP ${response.status}）`);
    if (!response.body) throw new Error('浏览器无法读取游戏列表');
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '', size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (controller.signal.aborted) throw controller.signal.reason;
      if (done) break;
      size += value.byteLength;
      if (size > CATALOG_LIMIT) throw new Error('游戏列表过大，请联系站点维护者');
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  };
  try {
    return await Promise.race([read(), deadline]);
  } finally { clearTimeout(timer); controller.abort(); void reader?.cancel().catch(() => {}); }
}

export function validateCatalog(input, baseURL) {
  if (input?.schemaVersion !== 1 || !Array.isArray(input.games) || input.games.length > 16 || !Array.isArray(input.allowedOrigins)) {
    throw new Error('游戏列表格式不正确');
  }
  const base = new URL(baseURL);
  const allowedOrigins = input.allowedOrigins.map(value => {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value || url.username || url.password) {
      throw new Error('下载来源配置不正确');
    }
    if (base.protocol === 'https:' && url.protocol !== 'https:') throw new Error('安全页面只能使用 HTTPS 下载来源');
    return url.origin;
  });
  const games = input.games.map(game => {
    if (typeof game?.title !== 'string' || !game.title.trim() || game.title.length > 120 || typeof game.manifest !== 'string') {
      throw new Error('游戏条目格式不正确');
    }
    const url = new URL(game.manifest, base);
    if (url.origin !== base.origin || url.username || url.password || url.hash) throw new Error('游戏清单必须位于本站');
    return { title: game.title, manifestURL: url.href };
  });
  return { allowedOrigins, games };
}

export function validateDownloadSources(manifest, allowedOrigins) {
  for (const source of manifest.sources) {
    if (!allowedOrigins.includes(new URL(source).origin)) throw new Error('游戏的下载来源尚未获本站配置允许');
  }
  return manifest;
}

function bytes(value) {
  if (value >= 1024 ** 3) return (value / 1024 ** 3).toFixed(2) + ' GB';
  if (value >= 1024 ** 2) return (value / 1024 ** 2).toFixed(1) + ' MB';
  return Math.round(value / 1024) + ' KB';
}

// Downloaded files remain in the engine's OPFS cache. The player receives a
// File reference; copying them into the separate local library would double disk usage.
export function initOnlineGames({ play, canPlay, reportError, root = document }) {
  const list = root.getElementById('onlineGameList');
  const status = root.getElementById('onlineCatalogStatus');
  const refresh = root.getElementById('onlineRefreshBtn');
  if (!list || !status || !refresh) return;
  let loading = false;
  const entries = [];
  const updateRefresh = () => { refresh.disabled = loading || entries.some(entry => entry.busy); };

  function addEntry(game, manifest, allowedOrigins) {
    const card = root.createElement('section');
    card.className = 'online-game-card';
    const heading = root.createElement('h3'); heading.textContent = game.title;
    const size = root.createElement('p'); size.textContent = `${bytes(manifest.size)} · ${manifest.name}`;
    const lineLabel = root.createElement('label'); lineLabel.className = 'setting-field';
    const lineText = root.createElement('span'); lineText.textContent = '下载线路';
    const source = root.createElement('select'); source.setAttribute('aria-label', `${game.title}的下载线路`);
    manifest.sources.forEach((_, index) => {
      const option = root.createElement('option'); option.value = String(index); option.textContent = `线路 ${index + 1}`; source.append(option);
    });
    lineLabel.append(lineText, source);
    const progress = root.createElement('progress'); progress.max = manifest.size; progress.value = 0;
    progress.setAttribute('aria-label', `${game.title}已校验的下载进度`);
    const detail = root.createElement('p'); detail.className = 'online-download-status'; detail.setAttribute('role', 'status');
    detail.textContent = '下载会保存在当前浏览器中，可以暂停后继续。';
    const actions = root.createElement('div'); actions.className = 'player-actions';
    const download = root.createElement('button'); download.textContent = '下载或继续'; download.type = 'button';
    const pause = root.createElement('button'); pause.textContent = '暂停'; pause.type = 'button'; pause.disabled = true;
    const launch = root.createElement('button'); launch.textContent = '开始游玩'; launch.type = 'button'; launch.className = 'primary'; launch.disabled = true;
    actions.append(download, pause, launch); card.append(heading, size, lineLabel, progress, detail, actions); list.append(card);
    const entry = { busy: false, file: null, task: null }; entries.push(entry);
    let unsubscribe;
    const setBusy = value => {
      entry.busy = value; download.disabled = value; source.disabled = value;
      pause.disabled = !value; launch.disabled = value || !entry.file; updateRefresh();
    };
    download.addEventListener('click', async () => {
      if (entry.busy) return;
      setBusy(true);
      const index = Number(source.value);
      const sources = [manifest.sources[index], ...manifest.sources.filter((_, i) => i !== index)];
      unsubscribe?.();
      try {
      entry.task = new GameDownload({ ...manifest, sources }, { concurrency: 2, maxRetries: 3, allowedOrigins });
      unsubscribe = entry.task.subscribe(state => {
        progress.value = state.verifiedBytes;
        const speed = state.speedBytesPerSecond > 0 ? ` · ${bytes(state.speedBytesPerSecond)}/秒` : '';
        detail.textContent = `${state.message || ''} ${bytes(state.verifiedBytes)} / ${bytes(state.total)}${speed}`;
      });
        const result = await entry.task.start();
        if (result) {
          entry.file = new File([result.file], manifest.name, { type: 'application/octet-stream' });
          detail.textContent = '下载与校验完成，可以开始游玩。'; download.textContent = '读取已下载游戏';
        } else detail.textContent = '已暂停。可以切换线路，或稍后继续下载。';
      } catch (error) {
        entry.file = null; detail.textContent = `下载未完成：${error.message}`;
      } finally { setBusy(false); }
    });
    pause.addEventListener('click', async () => {
      pause.disabled = true; detail.textContent = '正在暂停，已校验的进度会保留…';
      try { await entry.task?.pause(); }
      catch (error) { detail.textContent = `暂停失败：${error.message}`; }
    });
    launch.addEventListener('click', () => {
      if (!canPlay()) { reportError('模拟器已经启动。请先保存并同步进度，再重新载入页面切换游戏。'); return; }
      if (entry.file) play(entry.file);
    });
  }

  async function load() {
    if (loading || entries.some(entry => entry.busy)) return;
    loading = true; updateRefresh(); list.replaceChildren(); entries.length = 0;
    status.textContent = '正在读取在线游戏列表…';
    try {
      const catalogURL = new URL('game-catalog.json', root.baseURI);
      const catalog = validateCatalog(await readCatalogJSON(catalogURL.href), catalogURL.href);
      if (!catalog.games.length) { status.textContent = '暂时没有在线游戏，可以在游戏库选择本地文件。'; return; }
      if (!globalThis.Worker || !globalThis.navigator?.storage?.getDirectory || !globalThis.navigator?.locks) {
        throw new Error('此浏览器无法保存可续传的下载，请使用支持本机存储的新版本浏览器，或选择本地文件');
      }
      for (const game of catalog.games) {
        const manifest = validateDownloadSources(validateManifest(await readCatalogJSON(game.manifestURL)), catalog.allowedOrigins);
        addEntry(game, manifest, catalog.allowedOrigins);
      }
      status.textContent = '下载后保存在当前浏览器。刷新页面后，点击“下载或继续”恢复进度。';
    } catch (error) { status.textContent = error.message; }
    finally { loading = false; updateRefresh(); }
  }
  refresh.addEventListener('click', load);
  void load();
}
