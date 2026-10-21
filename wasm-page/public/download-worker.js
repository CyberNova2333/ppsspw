import { downloadGame } from './game-download.js';

let active;
self.onmessage = async ({ data }) => {
  if (data.type === 'pause') { active?.abort(new DOMException('下载已暂停', 'AbortError')); return; }
  if (data.type !== 'start' || active) return;
  const controller = new AbortController();
  active = controller;
  try {
    const result = await downloadGame(data.manifest, { ...data.options, signal: controller.signal,
      onProgress: state => self.postMessage({ type: 'progress', state }) });
    self.postMessage({ type: 'complete', ...result });
  } catch (error) {
    if (controller.signal.aborted && error.name === 'AbortError') self.postMessage({ type: 'paused' });
    else self.postMessage({ type: 'error', code: error.code || 'DOWNLOAD', message: error.message || '下载未完成' });
  } finally { active = null; }
};
