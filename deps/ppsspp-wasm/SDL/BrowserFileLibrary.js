// Emscripten's pthread proxy waits for the Promise without blocking the browser.
addToLibrary({
  ppsspp_browser_file_size__deps: ['$UTF8ToString'],
  ppsspp_browser_file_size__proxy: 'sync',
  ppsspp_browser_file_size: (path) => globalThis.PpssppBrowserFiles?.size(UTF8ToString(path)) ?? -1,

  ppsspp_browser_has_files__proxy: 'sync',
  ppsspp_browser_has_files: () => globalThis.PpssppBrowserFiles?.hasFiles() ? 1 : 0,

  ppsspp_browser_read__deps: ['$UTF8ToString'],
  ppsspp_browser_read__proxy: 'sync',
  ppsspp_browser_read__async: 'auto',
  // Keep the outer function synchronous: Emscripten inserts a synchronous
  // pthread proxy here. An async outer function would return Promise as i32.
  ppsspp_browser_read: (path, offset, length, destination) => {
    const filename = UTF8ToString(path);
    return globalThis.PpssppBrowserFiles.read(filename, offset, length).then(bytes => {
      // Resolve the current heap after awaiting: another pthread may grow memory.
      HEAPU8.set(bytes, destination >>> 0);
      return bytes.byteLength;
    }).catch(error => {
      console.error('Browser game read failed:', filename, error);
      return -1;
    });
  },
});
