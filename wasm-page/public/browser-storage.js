// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of PPSSPW and is licensed under GNU AGPLv3 with Additional Terms (see LICENSE and LICENSE-ADDITIONAL_TERMS-zh-CN.md; ref: LICENSE-ADDITIONAL_TERMS-en.md).
/* Coordinate game File snapshots with cache mutations across pages and workers. */
(function (root) {
  'use strict';
  const DOWNLOAD_DIRECTORY = 'game-downloads';
  const NAME = 'ppsspp-game-storage';
  const error = (code, message) => Object.assign(new Error(message), { name: 'GameStorageError', code });
  function request(mode, action, locks = root.navigator?.locks) {
    if (!locks?.request) return Promise.reject(error('UNSUPPORTED', '此浏览器不支持安全的游戏存储访问，请使用支持 Web Locks 的浏览器'));
    return locks.request(NAME, { mode, ifAvailable: true }, lock => {
      if (!lock) throw error('BUSY', '游戏正在其他页面运行、下载或整理缓存，请结束相关任务并关闭游玩页面后重试');
      return action();
    });
  }
  root.PpssppGameStorage = {
    downloads(storage, create = false) {
      return storage.getDirectory().then(origin => origin.getDirectoryHandle(DOWNLOAD_DIRECTORY, { create }));
    },
    async clearDownloads(storage = root.navigator.storage) {
      try { await (await storage.getDirectory()).removeEntry(DOWNLOAD_DIRECTORY, { recursive: true }); }
      catch (error) { if (error.name !== 'NotFoundError') throw error; }
    },
    async downloadUsage(storage = root.navigator.storage) {
      const usage = { bytes: 0, files: 0 };
      async function walk(dir) {
        for await (const [, handle] of dir.entries()) {
          if (handle.kind === 'directory') await walk(handle);
          else { usage.bytes += (await handle.getFile()).size; usage.files++; }
        }
      }
      try { await walk(await this.downloads(storage)); }
      catch (error) { if (error.name !== 'NotFoundError') throw error; }
      return usage;
    },
    withShared(action, locks) { return request('shared', action, locks); },
    withExclusive(action, locks) { return request('exclusive', action, locks); },
    acquireShared(locks) {
      // The callback stays pending until release or the owning page is destroyed.
      return new Promise((resolve, reject) => {
        request('shared', () => new Promise(release => resolve(release)), locks).catch(reject);
      });
    },
  };
})(globalThis);
