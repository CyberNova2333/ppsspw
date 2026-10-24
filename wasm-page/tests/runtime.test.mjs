import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import '../public/browser-storage.js';
import { storageLocks } from './storage-locks.mjs';

// Load the actual runtime functions without running browser startup side effects.
const source = readFileSync(new URL('../public/ppsspp-runtime.js', import.meta.url), 'utf8');
const ast = ts.createSourceFile('runtime.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
function load(names, globals = {}, declarations = '') {
  const code = ast.statements.filter(n => ts.isFunctionDeclaration(n) && names.includes(n.name.text)).map(n => n.getText(ast)).join('\n');
  const context = vm.createContext({ Blob, TextDecoder, TextEncoder, Uint8Array, DataView, Map, Set, console, ...globals });
  vm.runInContext(declarations + '\n' + code, context);
  return context;
}

const availableStartupCapabilities = () => ({ webgl2: true, simd: true, crossOriginIsolated: true, sharedArrayBuffer: true });

function saveRestoreFixture(initial) {
  const roots = ['/home/web_user/.config/ppsspp', '/root/.config/ppsspp'];
  const storage = new Map(initial), backups = new Map(), player = new Map(), live = new Map(), state = new Map();
  const failures = {};
  const missing = () => Object.assign(new Error('missing'), { name: 'NotFoundError' });
  const directory = (map, type) => ({
    getFileHandle: async (name, { create = false } = {}) => {
      if (!map.has(name)) { if (!create) throw missing(); map.set(name, new Uint8Array()); }
      return {
        getFile: async () => ({ text: async () => typeof map.get(name) === 'string' ? map.get(name) : new TextDecoder().decode(map.get(name)) }),
        createWritable: async () => {
          let pending;
          return {
            write: async bytes => { if (failures.backup && type === 'backup') throw new Error('backup quota'); pending = bytes; },
            close: async () => map.set(name, pending), abort: async () => {},
          };
        },
      };
    },
    removeEntry: async name => { if (!map.delete(name)) throw missing(); },
  });
  const ctx = load(['loadPersistedFiles', 'selectPersistEntries', 'normalizePersistPath', 'persistConflictKey', 'detectMemstickDir',
    'archiveLegacyPersistFile', 'beginSaveMigration', 'rollbackSaveMigration', 'writeOpfsHandle'], {
    PERSIST_ROOTS: roots, OPFS_PERSIST_DIR: 'persist', _persistedFileState: state,
    opfsWalk: async () => [...storage.keys()].map(path => ({ path })),
    opfsRead: async path => { if (failures.read === path) throw new Error('read denied'); if (!storage.has(path)) throw missing(); return storage.get(path); },
    opfsPut: async (path, bytes) => {
      if (!storage.has(path)) storage.set(path, new Uint8Array());
      if (failures.write === path) throw new Error('write quota');
      storage.set(path, bytes);
    },
    opfsDelete: async path => { if (failures.remove === path) throw new Error('remove denied'); if (!storage.delete(path)) throw missing(); },
    opfsDir: async () => directory(player, 'player'),
    opfsParent: async (path, create, base) => { assert.equal(base, 'legacy-backups'); return { dir: directory(backups, 'backup'), name: path }; },
    fsMkdirP() {}, log() {}, showToast() {},
    fsStatDir: () => new Map([...live].map(([path, data]) => [path, { size: data.length, mtime: 1 }])),
  }, 'let _detectedMemstick;');
  const FS = { writeFile: (path, data) => live.set(path, data), unlink: path => live.delete(path) };
  return { roots, storage, backups, player, live, state, failures, restore: () => ctx.loadPersistedFiles(FS) };
}

test('mobile keyboard preserves portrait height and tracks the visible viewport while opening and closing', () => {
  for (const hasScreenOrientation of [true, false]) {
    const styles = new Map();
    const classes = new Map();
    const window = {
      innerWidth: 390, innerHeight: 844,
      visualViewport: { width: 390, height: 844, offsetTop: 0, offsetLeft: 0 },
      screen: hasScreenOrientation ? { orientation: { type: 'portrait-primary' } } : {},
    };
    const document = {
      activeElement: null,
      documentElement: { style: { setProperty: (key, value) => styles.set(key, value) } },
      body: { classList: { toggle: (name, value) => classes.set(name, !!value) } },
    };
    const ctx = load(['syncViewportSize', 'fullscreenElement', 'viewportOrientation', 'isTextEntryActive', 'revealPanelInput'],
      { window, document }, 'let stableViewportWidth = 0, stableViewportHeight = 0, stableViewportOrientation = "";');
    ctx.syncViewportSize({ reset: true });
    document.activeElement = { tagName: 'INPUT' };
    for (const height of [600, 340, 300]) {
      window.visualViewport.height = height;
      window.visualViewport.offsetTop = 90;
      ctx.syncViewportSize();
      assert.equal(classes.get('keyboard-open'), true);
      assert.equal(styles.get('--app-h'), '844px');
      assert.equal(styles.get('--visual-h'), height + 'px');
      assert.equal(styles.get('--visual-top'), '90px');
    }
    // Android may also resize innerHeight; this must not reset the baseline.
    window.innerHeight = 300;
    ctx.syncViewportSize();
    assert.equal(classes.get('keyboard-open'), true);
    assert.equal(styles.get('--app-h'), '844px');
    window.innerHeight = window.visualViewport.height = 844;
    window.visualViewport.offsetTop = 0;
    ctx.syncViewportSize();
    assert.equal(classes.get('keyboard-open'), false);
    assert.equal(styles.get('--visual-top'), '0px');
    // A real rotation must still establish a new baseline.
    window.innerWidth = window.visualViewport.width = 844;
    window.innerHeight = window.visualViewport.height = 390;
    if (hasScreenOrientation) window.screen.orientation.type = 'landscape-primary';
    ctx.syncViewportSize();
    assert.equal(classes.get('keyboard-open'), false);
    assert.equal(styles.get('--app-h'), '390px');
  }
});

test('keyboard viewport changes reveal the active field by scrolling only its panel section', () => {
  const scroller = { scrollTop: 0, getBoundingClientRect: () => ({ top: 110, bottom: 300 }) };
  let field = { top: 320, bottom: 364 };
  const input = {
    tagName: 'INPUT', closest: () => scroller, getBoundingClientRect: () => field,
    scrollIntoView: () => assert.fail('must not pan the page'),
  };
  const ctx = load(['revealPanelInput', 'isTextEntryActive'], { document: { activeElement: input } });
  ctx.revealPanelInput();
  assert.equal(scroller.scrollTop, 80);
  field = { top: 100, bottom: 144 };
  ctx.revealPanelInput();
  assert.equal(scroller.scrollTop, 54);
  field = { top: 150, bottom: 194 };
  ctx.revealPanelInput();
  assert.equal(scroller.scrollTop, 54);
});

test('Multiplayer invitation imports relay, room and session key without launching a game', () => {
  const saved = new Map();
  let cleaned;
  const ctx = load(['importNetworkInvite', 'storeNetworkSessionKey', 'readNetworkSessionKey'], {
    URLSearchParams,
    location: { hash: '#relay=wss%3A%2F%2F192.168.10.172%3A8081%2Fadhoc&room=game-night&session_key=shared-secret', pathname: '/', search: '' },
    window: { PPSSPPAdhoc: { endpoint: value => new URL(value) } },
    preferences: { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) },
    sessionStorage: { setItem: (key, value) => saved.set(key, value) },
    NETWORK_SERVER_KEY: 'server', NETWORK_ENABLE_KEY: 'enabled',
    history: { replaceState: (_, __, value) => { cleaned = value; } },
    log: () => {},
  }, 'let networkSessionKey = "";');
  ctx.importNetworkInvite();
  assert.equal(saved.get('server'), 'wss://192.168.10.172:8081/adhoc');
  assert.equal(saved.get('ppsspp-network-room'), 'game-night');
  assert.equal(saved.get('enabled'), '1');
  assert.equal(saved.get('ppsspp-relay-session-key'), 'shared-secret');
  assert.equal(cleaned, '/');
  ctx.location.hash = '#relay=wss%3A%2F%2F192.168.10.172%3A8081%2Fadhoc&room=another';
  ctx.importNetworkInvite();
  assert.equal(saved.get('ppsspp-relay-session-key'), 'shared-secret');
  saved.clear();
  ctx.location.hash = '#relay=wss%3A%2F%2Fexample.org%2Fadhoc&room=%3Cscript%3E';
  ctx.importNetworkInvite();
  assert.equal(saved.size, 0);
  ctx.location.hash = '#relay=wss%3A%2F%2Fexample.org%2Fadhoc&room=friends';
  ctx.importNetworkInvite();
  assert.equal(saved.get('ppsspp-relay-session-key'), '');
});

test('SDL keyboard input is scoped to the canvas before native startup', () => {
  const env = { LANG: 'it_IT.UTF-8' };
  const ctx = load(['configureEmulatorKeyboard']);
  ctx.configureEmulatorKeyboard(env);
  assert.equal(env.SDL_EMSCRIPTEN_KEYBOARD_ELEMENT, '#canvas');
  assert.equal(env.LANG, 'it_IT.UTF-8');
  assert.equal(env.HOME, '/home/web_user');
  assert.equal(env.XDG_CONFIG_HOME, '/home/web_user/.config');
  const preRun = source.slice(source.indexOf('preRun: [function () {'));
  assert.ok(preRun.indexOf('configureEmulatorKeyboard(ENV)') < preRun.indexOf('addRunDependency('));
});

test('controller connections and reconnects preserve the focused form control', () => {
  const pad = { index: 0, connected: true };
  const remembered = [];
  let flashes = 0;
  const ctx = load(['onGamepadConnected', 'reconnectKnownGamepadsForSDL'], {
    canvas: { focus() { assert.fail('controller event stole keyboard focus'); } },
    getBrowserGamepads: () => [pad],
    rememberGamepad: gp => remembered.push(gp),
    dispatchSDLGamepadReconnect: () => true,
    flashGamepadBadge: () => flashes++,
  });
  ctx.onGamepadConnected({ gamepad: pad });
  ctx.onGamepadConnected({ gamepad: pad, __ppssppSynthetic: true });
  assert.equal(ctx.reconnectKnownGamepadsForSDL('window focus'), 1);
  assert.equal(remembered.length, 3);
  assert.equal(flashes, 1);
});

test('import stores the File/Blob directly and never enables startup preload', async () => {
  const blob = new Blob(['not an ISO']);
  blob.arrayBuffer = () => { throw new Error('whole-file allocation'); };
  let stored;
  const ctx = load(['opfsPutGame', 'writeOpfsHandle'], {
    PpssppGameStorage: { withExclusive: action => action() },
    OPFS_GAMES_DIR: 'games',
    opfsParent: async () => ({ name: 'game.cso', dir: { getFileHandle: async () => ({ createWritable: async () => ({ write: async value => { stored = value; }, close: async () => {} }) }) } }),
    writeGameMetadata: async () => {}, log: () => {},
    setPreloadFavorite: () => { throw new Error('implicit preload'); },
  });
  assert.equal(await ctx.opfsPutGame('game.cso', blob), 'game.cso');
  assert.equal(stored, blob);
});

function isoFixture() {
  const bytes = new Uint8Array(24 * 2048);
  const view = new DataView(bytes.buffer);
  const record = (offset, sector, size, name, dir) => {
    const length = 33 + name.length + (name.length % 2 === 0 ? 1 : 0);
    bytes[offset] = length; view.setUint32(offset + 2, sector, true); view.setUint32(offset + 10, size, true);
    bytes[offset + 25] = dir ? 2 : 0; bytes[offset + 32] = name.length;
    bytes.set(new TextEncoder().encode(name), offset + 33);
  };
  bytes[16 * 2048] = 1; bytes.set(new TextEncoder().encode('CD001'), 16 * 2048 + 1);
  record(16 * 2048 + 156, 20, 2048, '\0', true);
  record(20 * 2048, 21, 2048, 'PSP_GAME', true);
  record(21 * 2048, 22, 4, 'ICON0.PNG;1', false);
  bytes.set([137,80,78,71], 22 * 2048);
  return bytes;
}

test('ISO metadata reads only bounded extents, never the whole Blob', async () => {
  const blob = new Blob([isoFixture()]);
  blob.arrayBuffer = () => { throw new Error('whole-file allocation'); };
  let readBytes = 0;
  const slice = blob.slice.bind(blob);
  blob.slice = (start, end) => { readBytes += end - start; return slice(start, end); };
  const ctx = load(['isoFindBlobEntry', 'readIsoDirRecord']);
  assert.deepEqual(Array.from(await ctx.isoFindBlobEntry(blob, 'PSP_GAME/ICON0.PNG')), [137,80,78,71]);
  assert.equal(readBytes, 3 * 2048 + 4);
  assert.equal(await ctx.isoFindBlobEntry(blob, 'PSP_GAME/ABSENT'), null);
});

test('malformed ISO extents cannot request an unbounded allocation', async () => {
  const bytes = isoFixture();
  new DataView(bytes.buffer).setUint32(16 * 2048 + 156 + 10, 0xffffffff, true);
  const ctx = load(['isoFindBlobEntry', 'readIsoDirRecord']);
  await assert.rejects(ctx.isoFindBlobEntry(new Blob([bytes]), 'PSP_GAME/ICON0.PNG'), /Invalid ISO extent/);
});

test('startup mounts explicitly selected favorites of any size, skipping the game already launched', async () => {
  const loaded = [], written = [];
  const ctx = load(['preloadStoredGames'], {
    OPFS_GAMES_DIR: 'games', VIRTUAL_GAME_DIR: '/games', selectedStoredGame: 'playing.iso', selectedGame: null,
    opfsWalk: async () => [
      { path: 'large.iso', size: 1800 * 1024 ** 2 }, { path: 'small.iso', size: 40 },
      { path: 'playing.iso', size: 500 * 1024 ** 2 }, { path: 'unselected.iso', size: 80 },
    ],
    prunePreloadFavorites: () => ['large.iso', 'small.iso', 'playing.iso'],
    opfsGetGameFile: async name => { loaded.push(name); return { name, size: 1800 * 1024 ** 2, arrayBuffer() { throw new Error('must not allocate whole game'); } }; },
    mountBrowserGame: (_FS, file, name) => written.push('/games/' + name),
    log() {}, setStatus() {}, showLoading() {}, formatBytes: String,
  });
  assert.equal(await ctx.preloadStoredGames({ mkdirTree() {}, writeFile: path => written.push(path) }), 2);
  assert.deepEqual(loaded, ['large.iso', 'small.iso']);
  assert.deepEqual(written, ['/games/large.iso', '/games/small.iso']);
});

test('a failed automount does not prevent other selected games from mounting', async () => {
  const written = [];
  const ctx = load(['preloadStoredGames'], {
    OPFS_GAMES_DIR: 'games', VIRTUAL_GAME_DIR: '/games', selectedStoredGame: null, selectedGame: null,
    opfsWalk: async () => [{ path: 'bad.iso' }, { path: 'good.iso' }],
    prunePreloadFavorites: names => names,
    opfsGetGameFile: async name => { if (name === 'bad.iso') throw new Error('read failed'); return { name, size: 40 }; },
    mountBrowserGame: (_FS, file, name) => written.push('/games/' + name),
    log() {}, setStatus() {}, showLoading() {}, formatBytes: String,
  });
  assert.equal(await ctx.preloadStoredGames({ mkdirTree() {}, writeFile: path => written.push(path) }), 1);
  assert.deepEqual(written, ['/games/good.iso']);
});

test('concurrent persistence requests run in sequence even after a failure', async () => {
  const events = [];
  let count = 0;
  const ctx = load(['persistFiles'], {
    log: () => {}, persistFilesNow: async () => {
      const index = ++count; events.push(`start${index}`);
      await new Promise(r => setTimeout(r, 5)); events.push(`end${index}`);
      if (index === 1) throw new Error('quota');
    },
  }, 'let persistQueue = Promise.resolve();');
  await Promise.allSettled([ctx.persistFiles({}, 'auto'), ctx.persistFiles({}, 'manual')]);
  assert.deepEqual(events, ['start1', 'end1', 'start2', 'end2']);
});

test('failed OPFS deletion remains dirty so a later sync retries it', async () => {
  const state = new Map([['/save', '1:1'], ['/deleted', '2:1']]);
  let fail = true;
  const ctx = load(['persistFilesNow'], {
    hasOPFS: () => true, detectMemstickDir: () => '/root', fsStatDir: () => new Map([['/save', { size: 1, mtime: 1 }]]),
    _persistedFileState: state, log: () => {}, updateStorageInfo: () => {},
    opfsDelete: async () => { if (fail) throw new Error('denied'); },
  }, 'let _detectedMemstick, _lastPersistTime;');
  await ctx.persistFilesNow({}, 'auto');
  assert.equal(state.has('/deleted'), true);
  fail = false;
  await ctx.persistFilesNow({}, 'auto');
  assert.equal(state.has('/deleted'), false);
});

test('settings recovery backs up configs and preserves saves and controller mappings', async () => {
  const deleted = [], backups = [];
  const ctx = load(['resetEmulatorSettings'], {
    started: false, runtimeFailed: false, runtimeReady: false, confirm: () => true, persistQueue: Promise.resolve(), OPFS_PERSIST_DIR: 'persist',
    opfsWalk: async () => ['ppsspp.ini', 'GAME123.ini', 'controls.ini'].map(name => ({ path: '/root/PSP/SYSTEM/' + name })).concat([{ path: '/root/PSP/SAVEDATA/GAME/DATA.BIN' }]),
    opfsRead: async () => new Uint8Array([1]), opfsPut: async path => backups.push(path), opfsDelete: async path => deleted.push(path),
    window: {}, _persistedFileState: new Map(), showToast: () => {}, log: () => {}, resetPlayerSettings: async () => {},
  });
  await ctx.resetEmulatorSettings();
  assert.equal(deleted.length, 2);
  assert.ok(deleted.every(path => !/controls|SAVEDATA/.test(path)));
  assert.deepEqual(backups, deleted.map(path => path + '.recovery-backup'));
});

const swSource = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
function serviceWorker(globals) {
  const ctx = vm.createContext({ Request, Response, Headers, URL, self: { addEventListener() {} }, ...globals });
  vm.runInContext(swSource, ctx); return ctx;
}
for (const strategy of ['cacheFirst', 'networkFirst']) {
  test(`${strategy} still serves isolated responses when Cache Storage is denied`, async () => {
    const ctx = serviceWorker({ caches: { open: async () => { throw new Error('denied'); } }, fetch: async () => new Response('wasm') });
    const response = await ctx[strategy](new Request('https://example.test/core.wasm'));
    assert.equal(await response.text(), 'wasm');
    assert.equal(response.headers.get('Cross-Origin-Embedder-Policy'), 'require-corp');
  });
  test(`${strategy} does not turn quota errors into failed network requests`, async () => {
    const ctx = serviceWorker({ caches: { open: async () => ({ match: async () => undefined, put: async () => { throw new Error('quota'); } }) }, fetch: async () => new Response('ok') });
    assert.equal(await (await ctx[strategy](new Request('https://example.test/core.wasm'))).text(), 'ok');
  });
}

test('denied localStorage preserves tab preferences and removal semantics', () => {
  const wrapper = ast.statements.find(n => ts.isVariableStatement(n) && n.declarationList.declarations.some(d => d.name.getText(ast) === 'preferences')).getText(ast);
  const ctx = vm.createContext({ localStorage: { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } } });
  vm.runInContext(wrapper + '; globalThis.prefs = preferences;', ctx);
  assert.equal(ctx.prefs.getItem('x'), null);
  ctx.prefs.setItem('x', '1'); assert.equal(ctx.prefs.getItem('x'), '1');
  ctx.prefs.removeItem('x'); assert.equal(ctx.prefs.getItem('x'), null);
});

test('failed preload never releases the dependency and starts the core without its files', async () => {
  const failures = [], removed = [];
  const noop = () => {};
  const ctx = load(['start', 'configureEmulatorKeyboard'], {
    probeWebGLFeaturesWithPref: availableStartupCapabilities,
    PpssppGameStorage: { acquireShared: async () => {} },
    ENV: {},
    loadNetworkConfig: () => ({ enabled: false }),
    started: false, runtimeReady: false, selectedGame: null, selectedStoredGame: null, validateGameSelection: () => true, canvas: { focus() {} }, fileLabel: null, fileInput: null, gpuSelectEl: null,
    SharedArrayBuffer, sessionStorage: { removeItem() {} }, COI_RELOAD_KEY: 'coi',
    document: { body: { classList: { add() {} }, appendChild() {} }, createElement: () => ({}) },
    setStartButtonMode: noop, log: noop, showLoading: noop, setStatus: noop, setTimeout: () => 1,
    selectBuildDir: async () => {}, AudioContext: class { async resume() {} }, installScriptProcessorPolyfill: async () => {},
    preferences: { getItem: () => null }, BUILD_DIR: '/build/', BUILD_STAMP: 'test',
    addRunDependency: noop, removeRunDependency: dep => removed.push(dep),
    preloadAssets: async () => { throw new Error('asset missing'); }, FS: {},
    failRuntime: message => failures.push(message),
  });
  ctx.window = ctx; ctx.crossOriginIsolated = true;
  await ctx.start();
  ctx.Module.preRun[0]();
  assert.equal(ctx.ENV.SDL_EMSCRIPTEN_KEYBOARD_ELEMENT, '#canvas');
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(removed, []);
  assert.match(failures[0], /asset missing/);
  ctx.runtimeFailed = true;
  ctx.clearTimeout = noop;
  ctx.Module.onRuntimeInitialized();
  assert.equal(ctx.runtimeReady, false, 'a late core callback must not clear the failure state');
});

test('direct game launch also runs library automount before releasing startup', async () => {
  const events = [];
  const noop = () => {};
  const ctx = load(['start', 'configureEmulatorKeyboard'], {
    probeWebGLFeaturesWithPref: availableStartupCapabilities,
    PpssppGameStorage: { acquireShared: async () => {} },
    ENV: {}, loadNetworkConfig: () => ({ enabled: false }),
    started: false, runtimeReady: false, selectedGame: null, selectedStoredGame: null, validateGameSelection: () => true, canvas: { focus() {} }, fileLabel: null, fileInput: null, gpuSelectEl: null,
    SharedArrayBuffer, sessionStorage: { removeItem() {} }, COI_RELOAD_KEY: 'coi',
    document: { body: { classList: { add() {} }, appendChild() {} }, createElement: () => ({}) },
    setStartButtonMode: noop, log: noop, showLoading: noop, setStatus: noop, setTimeout: () => 1,
    selectBuildDir: async () => {}, AudioContext: class { async resume() {} }, installScriptProcessorPolyfill: async () => {},
    preferences: { getItem: () => null }, BUILD_DIR: '/build/', BUILD_STAMP: 'test',
    addRunDependency: noop, removeRunDependency: () => events.push('ready'),
    preloadAssets: async () => {}, loadPersistedFiles: async () => {}, forceGamesDirectoryConfig: async () => {},
    playerSettingsQueue: Promise.resolve(), restorePlayerSettings: async () => {},
    loadPlayerSettings: () => ({ resolution: 1, touch: false, showFps: false }),
    preloadGame: async () => { events.push('selected'); return '/games/playing.iso'; },
    preloadStoredGames: async () => events.push('automount'), emulatorLaunchArgs: () => [], FS: {},
    failRuntime: message => assert.fail(message),
  });
  ctx.window = ctx; ctx.crossOriginIsolated = true;
  await ctx.start();
  ctx.Module.preRun[0]();
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(events, ['selected', 'automount', 'ready']);
  assert.deepEqual(Array.from(ctx.Module.arguments), ['/games/playing.iso']);
});

test('native PSP saves support SAVEDATA and individual game folders without changing slot names', () => {
  const ctx = load(['nativeSaveRelativePath']);
  for (const path of ['PSP/SAVEDATA/ULUS12345/PARAM.SFO', 'SAVEDATA/ULUS12345/PARAM.SFO', 'ULUS12345/PARAM.SFO']) {
    assert.equal(ctx.nativeSaveRelativePath({ webkitRelativePath: path }), 'ULUS12345/PARAM.SFO');
  }
  assert.throws(() => ctx.nativeSaveRelativePath({ webkitRelativePath: 'DATA.BIN' }), /请选择 SAVEDATA/);
  assert.throws(() => ctx.nativeSaveRelativePath({ webkitRelativePath: 'SAVEDATA/../DATA.BIN' }), /无效/);
});

test('a failed OPFS write aborts the transaction instead of committing a truncated file', async () => {
  let aborted = false, closed = false;
  const ctx = load(['writeOpfsHandle']);
  await assert.rejects(ctx.writeOpfsHandle({ createWritable: async () => ({
    write: async () => { throw new Error('quota'); }, close: async () => { closed = true; }, abort: async () => { aborted = true; },
  }) }, new Blob(['data'])), /quota/);
  assert.equal(aborted, true); assert.equal(closed, false);
});

test('caching a large WASM response does not delay streaming it to the browser', async () => {
  const ctx = serviceWorker({ caches: { open: async () => ({ match: async () => undefined, put: () => new Promise(() => {}) }) }, fetch: async () => new Response('wasm') });
  let cacheTask;
  const response = await ctx.cacheFirst(new Request('https://example.test/core.wasm'), { waitUntil(task) { cacheTask = task; } });
  assert.equal(await response.text(), 'wasm');
  assert.ok(cacheTask);
});

test('blocked session storage cannot cause an endless isolation reload loop', async () => {
  const statuses = [];
  const ctx = load(['reloadForCrossOriginIsolation'], {
    window: { crossOriginIsolated: false }, sessionStorage: { getItem() { throw new Error('denied'); } },
    COI_RELOAD_KEY: 'coi', setStatus: value => statuses.push(value), hideLoading() {},
    location: { reload() { throw new Error('must not reload'); } },
  });
  assert.equal(await ctx.reloadForCrossOriginIsolation('test'), false);
  assert.match(statuses[0], /阻止了网站存储/);
});

test('startup reports missing browser capabilities before initializing audio or loading the core', async () => {
  for (const [changes, expected] of [
    [{ webgl2: false }, /WebGL2/],
    [{ simd: false }, /SIMD/],
    [{ crossOriginIsolated: false }, /跨源隔离/],
    [{ sharedArrayBuffer: false }, /共享内存/],
    [{ webgl2: false, simd: false, crossOriginIsolated: false, sharedArrayBuffer: false }, /WebGL2.*SIMD.*跨源隔离.*共享内存/],
  ]) {
    const messages = [], capabilities = { ...availableStartupCapabilities(), ...changes };
    const ctx = load(['start', 'reloadForCrossOriginIsolation'], {
      started: false, selectedGame: { name: 'game.iso' }, selectedStoredGame: null,
      validateGameSelection: () => true, canvas: {}, gpuSelectEl: null,
      probeWebGLFeaturesWithPref: () => capabilities,
      window: { crossOriginIsolated: capabilities.crossOriginIsolated }, navigator: {},
      SharedArrayBuffer: capabilities.sharedArrayBuffer ? SharedArrayBuffer : undefined,
      sessionStorage: { getItem: () => '0' }, COI_RELOAD_KEY: 'coi',
      setStatus: text => messages.push(text), log() {}, hideLoading() {},
      AudioContext: class { constructor() { assert.fail('audio initialized'); } },
      selectBuildDir: () => assert.fail('core loading started'),
      location: { reload: () => assert.fail('unsupported environment reloaded') },
    });
    await ctx.start();
    assert.equal(ctx.started, false);
    assert.match(messages[0], expected);
    assert.match(messages[0], /完整浏览器/);
    assert.equal(ctx.Module, undefined);
  }
});

test('graphics probing still reports SIMD and isolation when WebGL context creation fails', () => {
  const values = new Map();
  const ctx = load(['probeWebGLFeaturesWithPref'], {
    document: { createElement: () => ({ getContext() { throw new Error('context denied'); } }) },
    WebAssembly: { validate: () => false }, window: { crossOriginIsolated: false }, SharedArrayBuffer: undefined,
    navigator: { hardwareConcurrency: 4 }, gpuBadge: null, log() {},
    setInfoVal: (key, value, state) => values.set(key, { value, state }),
  });
  const result = ctx.probeWebGLFeaturesWithPref('default');
  assert.equal(result.webgl2, false); assert.equal(result.simd, false);
  assert.deepEqual(values.get('iSIMD'), { value: 'no', state: 'bad' });
  assert.deepEqual(values.get('iCOI'), { value: 'false', state: 'bad' });
  assert.deepEqual(values.get('iSAB'), { value: 'no', state: 'bad' });
});

test('isolated pages without SharedArrayBuffer receive an actionable failure without retrying isolation', async () => {
  const messages = [];
  const ctx = load(['reloadForCrossOriginIsolation'], {
    window: { crossOriginIsolated: true }, SharedArrayBuffer: undefined,
    setStatus: text => messages.push(text), hideLoading() {},
    navigator: { serviceWorker: { register: () => assert.fail('isolation retried') } },
    location: { reload: () => assert.fail('page reloaded') },
  });
  assert.equal(await ctx.reloadForCrossOriginIsolation('launch'), false);
  assert.match(messages[0], /共享内存.*完整浏览器/);
});

for (const pendingPhase of ['registration', 'ready']) {
  test(`isolation recovery times out during ${pendingPhase} and ignores its late completion`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let finish, reloads = 0, hidden = 0;
    const pending = new Promise(resolve => { finish = resolve; });
    const messages = [], logs = [];
    const ctx = load(['reloadForCrossOriginIsolation'], {
      window: { crossOriginIsolated: false }, COI_RELOAD_KEY: 'coi',
      sessionStorage: { getItem: () => '0', setItem() {} },
      navigator: { serviceWorker: {
        register: () => pendingPhase === 'registration' ? pending : Promise.resolve(),
        ready: pendingPhase === 'ready' ? pending : Promise.resolve(),
      } },
      setStatus: text => messages.push(text), log: text => logs.push(text),
      showLoading() {}, hideLoading: () => hidden++, setStartButtonMode() {}, setTimeout, clearTimeout,
      location: { reload: () => reloads++ },
    });
    const recovery = ctx.reloadForCrossOriginIsolation('launch');
    t.mock.timers.tick(10000);
    assert.equal(await recovery, false);
    assert.equal(reloads, 0); assert.equal(hidden, 1);
    assert.match(messages.at(-1), /准备失败.*完整浏览器.*COOP\/COEP/);
    assert(logs.some(text => text.includes('超时')));
    finish();
    await Promise.resolve(); await Promise.resolve();
    assert.equal(reloads, 0, 'late readiness must not refresh a page after showing failure');
  });
}

test('isolation recovery reloads only after successful readiness and clears its deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let reloads = 0;
  const messages = [];
  const ctx = load(['reloadForCrossOriginIsolation'], {
    window: { crossOriginIsolated: false }, COI_RELOAD_KEY: 'coi',
    sessionStorage: { getItem: () => '0', setItem() {} },
    navigator: { serviceWorker: { register: async () => {}, ready: Promise.resolve() } },
    setStatus: text => messages.push(text), log() {}, showLoading() {}, hideLoading() {}, setStartButtonMode() {},
    setTimeout, clearTimeout, location: { reload: () => reloads++ },
  });
  assert.equal(await ctx.reloadForCrossOriginIsolation('launch'), false);
  assert.equal(reloads, 1);
  t.mock.timers.tick(10000);
  assert.equal(messages.length, 1);
  ctx.navigator.serviceWorker.register = async () => { throw new Error('registration denied'); };
  assert.equal(await ctx.reloadForCrossOriginIsolation('launch'), false);
  assert.equal(reloads, 1, 'failed registration must not trigger another reload');
  assert.match(messages.at(-1), /准备失败/);
});

test('game downloads stream through OPFS with backpressure instead of accumulating chunks in RAM', async () => {
  const written = []; let closed = false;
  const handle = {
    createWritable: async () => new WritableStream({ write(chunk) { written.push(...chunk); }, close() { closed = true; } }),
    getFile: async () => new Blob([new Uint8Array(written)]),
  };
  const ctx = load(['storeGameResponse'], {
    TransformStream, performance, OPFS_GAMES_DIR: 'games', showLoading() {}, formatBytes: String, writeGameMetadata: async () => {}, log() {},
    opfsParent: async () => ({ name: 'game.cso', dir: { getFileHandle: async () => handle } }),
  });
  const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1, 2])); controller.enqueue(new Uint8Array([3, 4])); controller.close(); } }));
  response.arrayBuffer = () => { throw new Error('whole download allocation'); };
  const stored = await ctx.storeGameResponse('game.cso', response);
  assert.equal(stored.size, 4); assert.deepEqual(written, [1,2,3,4]); assert.equal(closed, true);
});

test('an interrupted game download aborts the OPFS transaction', async () => {
  let aborted = false;
  const ctx = load(['storeGameResponse'], {
    TransformStream, performance, OPFS_GAMES_DIR: 'games',
    opfsParent: async () => ({ name: 'game.iso', dir: { getFileHandle: async () => ({ createWritable: async () => new WritableStream({ abort() { aborted = true; } }) }) } }),
  });
  const response = new Response(new ReadableStream({ start(controller) { controller.error(new Error('connection lost')); } }));
  await assert.rejects(ctx.storeGameResponse('game.iso', response), /connection lost/);
  assert.equal(aborted, true);
});

test('a packaged cache revision always selects its matching core, even beside an older local release', async () => {
  const checked = [], selected = [];
  const ctx = load(['selectBuildDir'], {
    fetch: async () => ({ ok: true, json: async () => ({ revision: 'a'.repeat(64) }) }),
    hasBuildFile: async (dir, name) => { checked.push(dir); return true; },
    setBuildDir: dir => selected.push(dir), log() {}, BUILD_DIR: 'build-wasm/', BUILD_STAMP: 'timestamp',
  });
  await ctx.selectBuildDir();
  assert.deepEqual(selected, ['build-wasm/']);
  assert.ok(checked.every(dir => dir === 'build-wasm/'));
  assert.equal(ctx.BUILD_STAMP, 'a'.repeat(64));
});

test('startup rejects a partial core instead of loading mismatched JS/WASM/data', async () => {
  const ctx = load(['selectBuildDir'], {
    fetch: async () => ({ ok: false }), hasBuildFile: async (dir, name) => name !== 'PPSSPPSDL.wasm',
    setBuildDir() { throw new Error('must not select a partial build'); }, log() {},
  });
  await assert.rejects(ctx.selectBuildDir(), /模拟器资源不完整/);
});

test('startup applies player preferences while preserving unrelated graphics, timing and audio settings', async () => {
  const declarations = ast.statements.filter(n => ts.isVariableStatement(n) &&
    n.declarationList.declarations.some(d => ['WEB_NATIVE_TIMING_CONFIG', 'WEB_STABILITY_CONFIG', 'MOBILE_TOUCH_CONFIG'].includes(d.name.getText(ast))))
    .map(n => n.getText(ast)).join('\n');
  const original = '[Graphics]\nInternalResolution = 4\nSoftwareRenderer = True\nTexScalingLevel = 5\nAnisotropyLevel = 4\nMultiSampleLevel = 3\nFrameSkip = 2\nAutoFrameSkip = True\nVerticalSync = False\n[General]\nForceLagSync2 = False\nUIScaleFactor = 1\n[Sound]\nEnable = False\n[Control]\nShowTouchControls = False\n';
  for (const mobile of [false, true]) {
    for (const legacyProfile of [null, 'performance', 'custom']) {
      let config = original;
      const ctx = load(['forceGamesDirectoryConfig', 'patchIniValue', 'applyMultiplayerTimingConfig', 'applyPlayerSettings'], {
        PERSIST_ROOTS: ['/config'], VIRTUAL_GAME_DIR: '/games',
        isMobileExperience: () => mobile, fsMkdirP() {},
        loadPlayerSettings: () => ({ resolution: 2, showFps: true, touch: false }),
        loadNetworkConfig: () => ({ enabled: false }),
        preferences: { getItem: () => legacyProfile },
        applyNetworkConfig: async (_, text) => text,
        opfsPut: async () => {}, log() {},
      }, declarations);
      const FS = { readFile: () => new TextEncoder().encode(config), writeFile: (_, bytes) => { config = new TextDecoder().decode(bytes); } };
      await ctx.forceGamesDirectoryConfig(FS);
      for (const line of original.split('\n').filter(line => line.includes('=') && !line.startsWith('InternalResolution'))) assert.ok(config.includes(line), line);
      assert.match(config, /InternalResolution = 2/);
      assert.match(config, /Language = zh_CN/);
      assert.match(config, /iShowStatusFlags = 6/);
      assert.match(config, /EnableWlan = False/);
      assert.match(config, /CurrentDirectory = \/games/);
      assert.match(config, /AudioBufferSize = 1024/);
      const saved = config;
      await ctx.forceGamesDirectoryConfig(FS);
      assert.equal(config, saved);
    }
  }
});

test('multiplayer disables native lag sleeps while retaining user graphics settings', () => {
  let enabled = true;
  const ctx = load(['applyMultiplayerTimingConfig', 'patchIniValue'], {
    loadNetworkConfig: () => ({ enabled }),
  });
  const original = '[General]\nForceLagSync2 = True\n[Graphics]\nFrameSkip = 1\nAutoFrameSkip = True\n';
  const result = ctx.applyMultiplayerTimingConfig(original);
  assert.match(result, /ForceLagSync2\s*=\s*False/);
  assert.match(result, /FrameSkip = 1/);
  assert.match(result, /AutoFrameSkip = True/);
  enabled = false;
  assert.equal(ctx.applyMultiplayerTimingConfig(original), original);
});

test('steady controller scans leave selector DOM alone while disconnects still update it', () => {
  let updates = 0;
  let pads = [{ index: 0, connected: true }];
  const ctx = load(['reconcileGamepads'], {
    getBrowserGamepads: () => pads,
    connectedGamepads: new Map([[0, { id: 'pad' }]]),
    rememberGamepad: () => false,
    updateGamepadSelector: () => updates++, log() {},
  });
  ctx.reconcileGamepads(); ctx.reconcileGamepads();
  assert.equal(updates, 0);
  pads = [];
  ctx.reconcileGamepads();
  assert.equal(updates, 1);
  assert.equal(ctx.connectedGamepads.size, 0);
});

test('network status distinguishes a relay check from an active game and surfaces failures', () => {
  const ctx = load(['networkStatusView']);
  const cfg = { enabled: true };
  assert.equal(ctx.networkStatusView(cfg, { state: 'idle' }, { state: 'unverified' }).title, 'Connection not checked');
  assert.equal(ctx.networkStatusView(cfg, null, { state: 'checking' }).tone, 'busy');
  const checked = ctx.networkStatusView(cfg, null, { state: 'reachable', checkedAt: 100 }, 200);
  assert.equal(checked.title, 'Relay reachable · game not connected');
  assert.notEqual(checked.tone, 'good');
  assert.equal(ctx.networkStatusView(cfg, null, { state: 'reachable', checkedAt: 100 }, 30100).title, 'Connection not checked');
  assert.equal(ctx.networkStatusView(cfg, { state: 'idle' }, { state: 'error', error: 'Access rejected' }).detail, 'Access rejected');
  assert.equal(ctx.networkStatusView(cfg, { state: 'registered', peers: [] }, { state: 'unverified' }).title, 'Connected to relay');
  assert.equal(ctx.networkStatusView(cfg, { state: 'registered', peers: [{}] }, { state: 'unverified' }).title, 'Connected with friends');
  assert.equal(ctx.networkStatusView(cfg, { state: 'registered', lastError: 'Data socket failed' }, { state: 'reachable' }).tone, 'error');
  assert.equal(ctx.networkStatusView(cfg, { state: 'disconnected' }, { state: 'unverified' }).title, 'Disconnected');
  assert.equal(ctx.networkStatusView({ enabled: false }, null, { state: 'unverified' }).title, 'Multiplayer disabled');
  assert.equal(ctx.networkStatusView(cfg, { state: 'registered' }, {}, 200, false).title, 'You are offline');
});

test('player startup settings update global configs while preserving every per-game profile', async () => {
  const declarations = ast.statements.filter(n => ts.isVariableStatement(n) &&
    n.declarationList.declarations.some(d => ['WEB_NATIVE_TIMING_CONFIG', 'WEB_STABILITY_CONFIG', 'MOBILE_TOUCH_CONFIG'].includes(d.name.getText(ast))))
    .map(n => n.getText(ast)).join('\n');
  const roots = ['/home/web_user/.config/ppsspp', '/root/.config/ppsspp'];
  const files = new Map(), persisted = new Map();
  const gamePaths = roots.map((root, index) => root + '/PSP/SYSTEM/TEST0000' + (index + 1) + '_ppsspp.ini');
  const gameProfile = '[Graphics]\nInternalResolution = 5\n[CPU]\nBlockLinking = False\n';
  for (const path of gamePaths) files.set(path, new TextEncoder().encode(gameProfile));
  const ctx = load(['forceGamesDirectoryConfig', 'patchIniValue', 'applyPlayerSettings', 'applyMultiplayerTimingConfig'], {
    PERSIST_ROOTS: roots, VIRTUAL_GAME_DIR: '/games', isMobileExperience: () => true,
    fsMkdirP() {}, log() {}, applyNetworkConfig: async (_, text) => text,
    loadNetworkConfig: () => ({ enabled: false }),
    loadPlayerSettings: () => ({ resolution: 3, showFps: true, touch: false }),
    opfsPut: async (path, bytes) => persisted.set(path, new TextDecoder().decode(bytes)),
  }, declarations);
  const FS = { analyzePath: path => ({ exists: files.has(path) }), readFile: path => files.get(path) || new TextEncoder().encode('[General]\nLanguage = en_US\n[Network]\nEnableWlan = True\n'), writeFile: (path, bytes) => files.set(path, bytes) };
  await ctx.forceGamesDirectoryConfig(FS);
  for (const root of roots) {
    const path = root + '/PSP/SYSTEM/ppsspp.ini';
    assert.equal(persisted.get(path), new TextDecoder().decode(files.get(path)));
    for (const pattern of [/Language = zh_CN/, /InternalResolution = 3/, /iShowStatusFlags = 6/, /ShowTouchControls = False/, /EnableWlan = False/]) assert.match(persisted.get(path), pattern);
  }
  for (const path of gamePaths) {
    assert.equal(persisted.has(path), false);
    assert.equal(new TextDecoder().decode(files.get(path)), gameProfile);
  }
  const before = [...persisted.values()];
  await ctx.forceGamesDirectoryConfig(FS);
  assert.deepEqual([...persisted.values()], before);
  for (const path of gamePaths) assert.equal(new TextDecoder().decode(files.get(path)), gameProfile);
});

test('settings changed during play are durable without mutating or restarting the live core', async () => {
  const settings = new Map();
  const controls = new Map([
    ['player-render-resolution', { value: '2' }], ['player-show-fps', { checked: true }],
    ['player-touch-controls', { checked: false }], ['player-settings-status', {}],
  ]);
  const roots = ['/home/web_user/.config/ppsspp', '/root/.config/ppsspp'];
  const writes = new Map(); let durable;
  const ctx = load(['savePlayerSettings', 'applyPlayerSettings', 'patchIniValue'], {
    byId: id => controls.get(id), PLAYER_SETTINGS_KEY: 'player', PERSIST_ROOTS: roots,
    preferences: { setItem: (k, v) => settings.set(k, v) }, started: true, hasOPFS: () => true,
    opfsDir: async () => ({ getFileHandle: async () => ({}) }),
    writeOpfsHandle: async (_, text) => { durable = JSON.parse(text); },
    opfsRead: async () => new TextEncoder().encode('[General]\nLanguage = en_US\n'),
    opfsPut: async (path, bytes) => writes.set(path, new TextDecoder().decode(bytes)), log() {},
    window: { FS: { writeFile: () => assert.fail('must not change running core settings') } },
  }, 'let playerSettingsQueue = Promise.resolve(), playerSettingsChanged = false;');
  await ctx.savePlayerSettings();
  assert.deepEqual(durable, { resolution: 2, showFps: true, touch: false });
  assert.equal(writes.size, 0, 'launcher changes must not compete with native INI persistence');
  assert.match(controls.get('player-settings-status').textContent, /下次启动生效/);
  assert.equal(settings.get('player'), JSON.stringify(durable));
});

test('settings write failures are visible and a later queued save still commits the latest values', async () => {
  const controls = new Map([
    ['player-render-resolution', { value: '2' }], ['player-show-fps', { checked: true }],
    ['player-touch-controls', { checked: false }], ['player-settings-status', {}],
  ]);
  const attempted = [], preferences = new Map();
  let fail = true;
  const ctx = load(['savePlayerSettings'], {
    byId: id => controls.get(id), PLAYER_SETTINGS_KEY: 'player', started: false,
    preferences: { setItem: (key, text) => preferences.set(key, text) }, hasOPFS: () => true,
    opfsDir: async () => ({ getFileHandle: async () => ({}) }),
    writeOpfsHandle: async (_, text) => { attempted.push(JSON.parse(text)); if (fail) throw new Error('quota'); }, log() {},
  }, 'let playerSettingsQueue = Promise.resolve(), playerSettingsChanged = false;');
  await ctx.savePlayerSettings();
  assert.match(controls.get('player-settings-status').textContent, /本地保存未完成/);
  assert.equal(JSON.parse(preferences.get('player')).resolution, 2);
  fail = false;
  controls.get('player-render-resolution').value = '1';
  const first = ctx.savePlayerSettings();
  controls.get('player-render-resolution').value = '3';
  const second = ctx.savePlayerSettings();
  await Promise.all([first, second]);
  assert.deepEqual(attempted.map(settings => settings.resolution), [2, 1, 3]);
  assert.match(controls.get('player-settings-status').textContent, /设置已保存/);
  assert.equal(JSON.parse(preferences.get('player')).resolution, 3);
});

test('manual sync reports failed writes and retries them without claiming success', async () => {
  const state = new Map(), messages = [];
  let fail = true;
  const ctx = load(['persistFilesNow', 'syncPlayerFiles'], {
    runtimeReady: true, window: { FS: { readFile: () => new Uint8Array([1]) } },
    hasOPFS: () => true, detectMemstickDir: () => '/root',
    fsStatDir: () => new Map([['/root/save', { size: 1, mtime: 1 }]]),
    _persistedFileState: state, opfsPut: async () => { if (fail) throw new Error('quota'); },
    log() {}, updateStorageInfo() {}, refreshSavesTab: async () => {}, showToast: text => messages.push(text),
  }, 'let _detectedMemstick, _lastPersistTime;');
  ctx.persistFiles = (FS, label) => ctx.persistFilesNow(FS, label);
  await ctx.syncPlayerFiles();
  assert.equal(state.has('/root/save'), false);
  assert.match(messages.at(-1), /同步未完成/);
  fail = false;
  await ctx.syncPlayerFiles();
  assert.equal(state.has('/root/save'), true);
  assert.match(messages.at(-1), /已同步到本机/);
});

test('local edition ignores old network enable preferences and blocks external actions', async () => {
  const ctx = load(['loadNetworkConfig', 'checkNetworkWhenVisible', 'testNetworkRelay', 'ensureGoogleToken', 'runDriveAction', 'addGameURLToLibrary'], {
    LOCAL_ONLY: true, NETWORK_MAC_KEY: 'mac', NETWORK_SERVER_KEY: 'server', NETWORK_ENABLE_KEY: 'enabled', NETWORK_NICK_KEY: 'nick',
    preferences: { getItem: key => key === 'mac' ? '02:00:00:00:00:01' : key === 'enabled' ? '1' : null, setItem() {} },
    sessionStorage: { getItem: () => '02:00:00:00:00:01' }, location: { href: 'https://local.test/' }, URL,
    readNetworkSessionKey: () => '', sanitizeNetworkNick: () => 'Player', sanitizeNetworkMac: value => value,
    showToast() {}, fetch: () => assert.fail('external request'),
  });
  assert.equal(ctx.loadNetworkConfig().enabled, false);
  ctx.checkNetworkWhenVisible();
  await ctx.testNetworkRelay();
  await ctx.runDriveAction('test', () => assert.fail('cloud action executed'));
  await ctx.addGameURLToLibrary('https://external.test/game.iso');
  await assert.rejects(ctx.ensureGoogleToken(true), /未启用云端服务/);
});

test('audio recovery resumes both interrupted tracked contexts and legacy global SDL audio', async () => {
  const resumed = [];
  const context = (state, name) => ({ state, resume: async () => { resumed.push(name); } });
  const ctx = load(['unlockAudio'], {
    window: { SDL2: { audioContext: context('suspended', 'sdl') } },
    trackedAudioContexts: [context('interrupted', 'tracked'), context('running', 'active'), context('closed', 'closed')],
  });
  await ctx.unlockAudio();
  assert.deepEqual(resumed, ['tracked', 'sdl']);
});

test('audio pump keeps clock-based lookahead without overproducing and tolerates timer jitter', async () => {
  const timers = new Map();
  let controls, calls = 0, timerId = 0;
  const audio = { state: 'running', currentTime: 1, sampleRate: 48000,
    createBuffer: (channels, frames) => {
      const data = Array.from({ length: channels }, () => new Float32Array(frames));
      return { getChannelData: channel => data[channel] };
    },
    createGain: () => ({ gain: { value: 1 }, connect() {}, disconnect() {} }),
  };
  const ctx = load(['makeScriptProcessorShim'], {
    Float32Array, Int32Array, SharedArrayBuffer, Atomics,
    ensureSpShimModule: async () => true, log() {}, audioDebug: { underruns: 0, callbacks: 0, nonsilent: 0 },
    AudioWorkletNode: class {
      constructor(_, __, options) { controls = new Int32Array(options.processorOptions.sab, 0, 8); }
      connect() {} disconnect() {}
    },
    setInterval: fn => { timers.set(++timerId, fn); return timerId; },
    clearInterval: id => timers.delete(id),
  });
  const shim = ctx.makeScriptProcessorShim(audio, 1024, 0, 2);
  shim.onaudioprocess = event => { calls++; event.outputBuffer.getChannelData(0).fill(0.25); };
  shim.connect({});
  await new Promise(resolve => setTimeout(resolve, 0));
  const initial = calls;
  assert.ok(initial * 1024 <= 48000 * 0.070 && initial * 1024 > 48000 * 0.070 - 1024);
  for (let i = 0; i < 50; i++) for (const pump of timers.values()) pump();
  assert.equal(calls, initial, 'timer bursts cannot advance the hardware audio clock');
  let consumed = 0;
  for (const ms of [8, 8, 24, 8, 40, 8, 16, 8, 32]) {
    const frames = ms * 48;
    const read = Atomics.load(controls, 1), write = Atomics.load(controls, 0);
    assert.ok((write - read + 32768) % 32768 >= frames, 'the prebuffer covers delayed timer callbacks');
    Atomics.store(controls, 1, (read + frames) % 32768);
    consumed += frames; audio.currentTime = 1 + consumed / 48000;
    for (const pump of timers.values()) pump();
    assert.ok(calls * 1024 <= consumed + 48000 * 0.070);
  }
  assert.equal(ctx.audioDebug.underruns, 0);
  const beforePause = calls;
  audio.state = 'suspended'; audio.currentTime += 1;
  for (const pump of timers.values()) pump();
  assert.equal(calls, beforePause);
  shim.disconnect();
  assert.equal(timers.size, 0);
});

test('legacy-root restore migrates complete missing slots and never mixes with current-root slots', async () => {
  const roots = ['/home/web_user/.config/ppsspp', '/root/.config/ppsspp'];
  const currentSlot = roots[0] + '/PSP/SAVEDATA/TEST00001A/';
  const legacySlot = roots[1] + '/PSP/SAVEDATA/TEST00001A/';
  const newSlot = '/PSP/SAVEDATA/TEST00001B/';
  const encode = text => new TextEncoder().encode(text);
  const fixture = saveRestoreFixture([
    [currentSlot + 'PARAM.SFO', encode('current')],
    [legacySlot + 'PARAM.SFO', encode('old')],
    [legacySlot + 'DATA.BIN', encode('old-slot-data')],
    [roots[1] + newSlot + 'PARAM.SFO', encode('legacy-param')],
    [roots[1] + newSlot + 'DATA.BIN', encode('legacy-data')],
  ]);
  const { storage, backups, player, live, state } = fixture;
  await fixture.restore();
  assert.equal(new TextDecoder().decode(live.get(currentSlot + 'PARAM.SFO')), 'current');
  assert.equal(live.has(currentSlot + 'DATA.BIN'), false, 'do not mix incomplete current slot with legacy files');
  for (const name of ['PARAM.SFO', 'DATA.BIN']) {
    const path = roots[0] + newSlot + name;
    assert.ok(live.has(path));
    assert.ok(storage.has(path), 'migrated copy must be durable before dirty state is seeded');
    assert.ok(state.has(path));
  }
  assert.equal(backups.size, 4, 'both migrated and conflicting legacy files must be archived');
  assert.equal(new TextDecoder().decode(backups.get(legacySlot + 'DATA.BIN')), 'old-slot-data');
  assert.equal([...storage.keys()].some(path => path.startsWith(roots[1] + '/')), false);
  assert.equal(player.has('save-migration.json'), false);
  assert.ok([...live.keys()].every(path => path.startsWith(roots[0] + '/')));
  for (const path of [...storage.keys()]) if (path.startsWith(roots[0] + newSlot)) storage.delete(path);
  live.clear();
  await fixture.restore();
  assert.equal([...live.keys()].some(path => path.startsWith(roots[0] + newSlot)), false, 'deleted migrated slots must not resurrect');
});

test('unreadable current-root saves stop startup before any migration or live write', async () => {
  const current = '/home/web_user/.config/ppsspp/PSP/SAVEDATA/A/DATA.BIN';
  const legacy = '/root/.config/ppsspp/PSP/SAVEDATA/B/DATA.BIN';
  const fixture = saveRestoreFixture([[legacy, new Uint8Array([1])], [current, new Uint8Array([2])]]);
  fixture.failures.read = current;
  await assert.rejects(fixture.restore(), { name: 'SaveRestoreError' });
  assert.equal(fixture.live.size, 0);
  assert.equal(fixture.backups.size, 0);
  assert.equal(fixture.storage.size, 2);
  assert.equal(fixture.state.size, 0);
});

test('failed migration rolls back a partial slot, including an empty failed-write target', async () => {
  const legacy = '/root/.config/ppsspp/PSP/SAVEDATA/A/';
  const current = '/home/web_user/.config/ppsspp/PSP/SAVEDATA/A/';
  const fixture = saveRestoreFixture([[legacy + 'PARAM.SFO', new Uint8Array([1])], [legacy + 'DATA.BIN', new Uint8Array([2])]]);
  fixture.failures.write = current + 'DATA.BIN';
  await assert.rejects(fixture.restore(), { name: 'SaveRestoreError' });
  assert.equal(fixture.storage.size, 2);
  assert.equal(fixture.live.size, 0);
  assert.equal(fixture.backups.size, 0);
  assert.equal(fixture.player.has('save-migration.json'), false);
  delete fixture.failures.write;
  await fixture.restore();
  assert.deepEqual([...fixture.live.keys()], [current + 'PARAM.SFO', current + 'DATA.BIN']);
});

test('a failed rollback remains journaled and retries before partial canonical slots can win', async () => {
  const legacy = '/root/.config/ppsspp/PSP/SAVEDATA/A/';
  const current = '/home/web_user/.config/ppsspp/PSP/SAVEDATA/A/';
  const fixture = saveRestoreFixture([[legacy + 'PARAM.SFO', new Uint8Array([1])], [legacy + 'DATA.BIN', new Uint8Array([2])]]);
  fixture.failures.write = current + 'DATA.BIN';
  fixture.failures.remove = current + 'PARAM.SFO';
  await assert.rejects(fixture.restore(), { name: 'SaveRestoreError' });
  assert.equal(fixture.player.has('save-migration.json'), true);
  assert.equal(fixture.storage.get(legacy + 'DATA.BIN')[0], 2);
  delete fixture.failures.write;
  delete fixture.failures.remove;
  fixture.live.clear();
  await fixture.restore();
  assert.equal(fixture.live.get(current + 'DATA.BIN')[0], 2);
  assert.equal(fixture.storage.has(legacy + 'DATA.BIN'), false);
  assert.equal(fixture.player.has('save-migration.json'), false);
});

test('failed legacy backup blocks startup and keeps the source until a retry archives it', async () => {
  const legacy = '/root/.config/ppsspp/PSP/SAVEDATA/A/DATA.BIN';
  const current = '/home/web_user/.config/ppsspp/PSP/SAVEDATA/A/DATA.BIN';
  const fixture = saveRestoreFixture([[legacy, new Uint8Array([7])]]);
  fixture.failures.backup = true;
  await assert.rejects(fixture.restore(), { name: 'SaveRestoreError' });
  assert.equal(fixture.storage.get(legacy)[0], 7);
  assert.equal(fixture.storage.get(current)[0], 7);
  assert.equal(fixture.state.size, 0);
  delete fixture.failures.backup;
  fixture.live.clear();
  await fixture.restore();
  assert.equal(fixture.backups.get(legacy)[0], 7);
  assert.equal(fixture.storage.has(legacy), false);
});

test('save list normalizes OPFS paths and prefers live/current data without duplicate legacy cards', async () => {
  const roots = ['/home/web_user/.config/ppsspp', '/root/.config/ppsspp'];
  const path = roots[0] + '/PSP/SAVEDATA/TEST00001A/DATA.BIN';
  const ctx = load(['buildSaveFileMap', 'selectPersistEntries', 'normalizePersistPath', 'persistConflictKey', 'detectMemstickDir'], {
    PERSIST_ROOTS: roots, window: { FS: {} },
    opfsWalk: async () => [
      { path: path.slice(1), data: new Uint8Array([1]) },
      { path: path.replace(roots[0], roots[1]).slice(1), data: new Uint8Array([2]) },
    ],
    fsWalkDir: () => [{ path, data: new Uint8Array([3]) }],
  });
  const map = await ctx.buildSaveFileMap();
  assert.equal(map.size, 1);
  assert.equal(map.get(path).data[0], 3);
  assert.equal(map.get(path).fromOPFS, false);
});

test('imported root-based backup reaches the canonical core directory without overwriting an existing slot', async () => {
  const roots = ['/home/web_user/.config/ppsspp', '/root/.config/ppsspp'];
  const current = roots[0] + '/PSP/SAVEDATA/TEST00001A/';
  const legacy = roots[1] + '/PSP/SAVEDATA/TEST00001A/';
  const missing = roots[1] + '/PSP/SAVEDATA/TEST00001B/DATA.BIN';
  const writes = new Map(), messages = [];
  const ctx = load(['importSavesBundleNow', 'selectPersistEntries', 'normalizePersistPath', 'persistConflictKey', 'detectMemstickDir'], {
    PERSIST_ROOTS: roots, OPFS_PERSIST_DIR: 'persist', window: { FS: { writeFile: (p, d) => writes.set(p, d) } },
    opfsWalk: async () => [{ path: current.slice(1) + 'PARAM.SFO' }],
    fsStatDir: () => new Map(), base64ToBytes: value => new Uint8Array([Number(value)]),
    opfsPut: async (path, bytes) => writes.set(path, bytes), fsMkdirP() {}, log() {},
    showToast: text => messages.push(text), refreshSavesTab() {}, updateStorageInfo() {},
  });
  assert.equal(await ctx.importSavesBundleNow({ files: [
    { path: legacy + 'PARAM.SFO', data: '1' }, { path: legacy + 'DATA.BIN', data: '2' }, { path: missing, data: '3' },
  ] }, 'backup'), 1);
  assert.deepEqual([...writes.keys()], [missing.replace(roots[1], roots[0])]);
  assert.match(messages.at(-1), /保留已有存档/);
});

test('a malformed later backup entry cannot partially overwrite existing saves', async () => {
  const roots = ['/home/web_user/.config/ppsspp', '/root/.config/ppsspp'];
  const current = roots[0] + '/PSP/SAVEDATA/A/';
  const ctx = load(['importSavesBundleNow', 'selectPersistEntries', 'normalizePersistPath', 'persistConflictKey'], {
    PERSIST_ROOTS: roots, OPFS_PERSIST_DIR: 'persist', window: {},
    opfsWalk: async () => [{ path: current + 'PARAM.SFO' }],
    base64ToBytes: value => { if (value === 'invalid') throw new Error('invalid base64'); return new Uint8Array([1]); },
    opfsPut: () => assert.fail('must validate the complete backup before changing stored files'),
  });
  await assert.rejects(ctx.importSavesBundleNow({ files: [
    { path: current + 'PARAM.SFO', data: 'valid' }, { path: current + 'DATA.BIN', data: 'invalid' },
  ] }, 'backup'), /invalid base64/);
});

test('an unreadable later native folder file cannot partially overwrite existing saves', async () => {
  const messages = [];
  const ctx = load(['importNativeSaveFolderNow', 'nativeSaveRelativePath'], {
    PERSIST_ROOTS: ['/home/web_user/.config/ppsspp'], window: {}, showToast: text => messages.push(text),
    opfsPut: () => assert.fail('must read the complete folder before changing stored files'),
  });
  await ctx.importNativeSaveFolderNow([
    { webkitRelativePath: 'A/PARAM.SFO', arrayBuffer: async () => new Uint8Array([1]).buffer },
    { webkitRelativePath: 'A/DATA.BIN', arrayBuffer: async () => { throw new Error('file unreadable'); } },
  ]);
  assert.match(messages.at(-1), /导入存档文件夹失败/);
});

test('unsupported archive selection never starts the core or enters game import paths', async () => {
  const messages = [];
  const ctx = load(['start', 'validateGameSelection', 'gameFileValidationError', 'addGameToLibrary', 'loadGameAtRuntime', 'playOrMountStoredGame'], {
    GAME_FILE_EXT_RE: /\.(iso|cso|chd|pbp|elf|prx)$/i,
    started: false, selectedGame: { name: 'game.zip' }, selectedStoredGame: null,
    setStatus: text => messages.push(text), showToast: text => messages.push(text),
    opfsPutGame: () => assert.fail('archive cached'), window: {},
  });
  await ctx.start();
  await ctx.addGameToLibrary({ name: 'game.7z' });
  await ctx.loadGameAtRuntime({ name: 'game.rar' });
  await ctx.playOrMountStoredGame('game.zip');
  assert.equal(ctx.started, false);
  assert.ok(messages.every(text => text.includes('先解压')));
  assert.equal(ctx.gameFileValidationError({ name: 'game.ISO' }), '');
  assert.equal(ctx.gameFileValidationError('game.cso'), '');
  assert.match(ctx.gameFileValidationError({ name: 'image.png' }), /不支持/);
});

test('game leases can coexist but prevent cache mutation until every page releases its lease', async () => {
  const { locks, held } = storageLocks();
  const storage = globalThis.PpssppGameStorage;
  const releaseFirst = await storage.acquireShared(locks);
  const releaseSecond = await storage.acquireShared(locks);
  assert.equal(held.get('ppsspp-game-storage').count, 2);
  await assert.rejects(storage.withExclusive(() => assert.fail('mutation entered'), locks), { code: 'BUSY' });
  releaseFirst(); await new Promise(resolve => setTimeout(resolve, 0));
  await assert.rejects(storage.withExclusive(() => assert.fail('other page still playing'), locks), { code: 'BUSY' });
  releaseSecond(); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(await storage.withExclusive(() => 'safe', locks), 'safe');
  assert.equal(held.size, 0);
});

test('library writes, deletion and complete cache clearing are blocked by another playing page', async () => {
  const { locks } = storageLocks();
  const release = await globalThis.PpssppGameStorage.acquireShared(locks);
  const messages = [];
  const ctx = load(['opfsPutGame', 'opfsClearAll', 'deleteStoredFile'], {
    PpssppGameStorage: { withExclusive: action => globalThis.PpssppGameStorage.withExclusive(action, locks) },
    VIRTUAL_GAME_DIR: '/browser-games', confirm: () => true,
    opfsRoot: () => assert.fail('storage changed'), opfsParent: () => assert.fail('game overwritten'),
    opfsDeleteGame: () => assert.fail('game deleted'), showToast: message => messages.push(message), log() {},
  });
  try {
    await assert.rejects(ctx.opfsPutGame('game.iso', new Blob(['x'])), { code: 'BUSY' });
    await assert.rejects(ctx.opfsClearAll(), { code: 'BUSY' });
    await ctx.deleteStoredFile('/browser-games/game.iso');
    assert.match(messages.at(-1), /其他页面/);
  } finally { release(); }
});

test('idle clearing includes downloaded games and reports deletion failures', async () => {
  const removed = [];
  const ctx = load(['opfsClearAll'], {
    PpssppGameStorage: { withExclusive: action => action() }, playerSettingsQueue: Promise.resolve(),
    OPFS_PERSIST_DIR: 'persist', OPFS_GAMES_DIR: 'games', OPFS_GAME_META_DIR: 'meta',
    PLAYER_SETTINGS_KEY: 'settings', PRELOAD_FAVORITES_KEY: 'favorites', PRELOAD_FAVORITES_MIGRATED_KEY: 'migrated',
    opfsRoot: async () => ({ removeEntry: async name => removed.push(name), getDirectoryHandle: async () => {} }),
    preferences: { removeItem() {} }, refreshPlayerSettingsUI() {},
  });
  await ctx.opfsClearAll();
  assert.deepEqual(removed, ['persist', 'games', 'meta', 'game-downloads', 'legacy-backups', 'player']);
  ctx.opfsRoot = async () => ({ removeEntry: async () => { throw new DOMException('denied', 'NotAllowedError'); } });
  await assert.rejects(ctx.opfsClearAll(), { name: 'NotAllowedError' });
});

test('a storage maintenance lease prevents startup and leaves the launch action retryable', async () => {
  const { locks } = storageLocks();
  const messages = [];
  const audio = [];
  const ctx = load(['start'], {
    probeWebGLFeaturesWithPref: availableStartupCapabilities,
    started: false, selectedGame: { name: 'game.iso' }, selectedStoredGame: null,
    validateGameSelection: () => true, canvas: { focus() {} }, SharedArrayBuffer,
    window: { crossOriginIsolated: true }, sessionStorage: { removeItem() {} }, COI_RELOAD_KEY: 'coi',
    PpssppGameStorage: { acquireShared: () => globalThis.PpssppGameStorage.acquireShared(locks) },
    document: { body: { classList: { add() {}, remove() {} } } },
    setTimeout: () => 1, clearTimeout() {}, log() {}, setStartButtonMode() {},
    fileLabel: null, fileInput: null, gpuSelectEl: null, showLoading() {}, hideLoading() {},
    AudioContext: class { async resume() { audio.push('resume'); } async close() { audio.push('close'); } },
    installScriptProcessorPolyfill: async () => {},
    setStatus: message => messages.push(message),
  });
  await globalThis.PpssppGameStorage.withExclusive(async () => {
    await ctx.start();
    assert.equal(ctx.started, false);
    assert.match(messages.at(-1), /整理缓存/);
    assert.deepEqual(audio, ['resume', 'close']);
  }, locks);
});

test('selected and runtime local games remain File references without implicit cache copies', async () => {
  const file = new Blob(['game']); file.name = 'game.iso';
  file.arrayBuffer = () => assert.fail('full file read');
  const mounted = [], messages = [];
  const ctx = load(['preloadGame', 'loadGameAtRuntime'], {
    selectedGame: file, selectedStoredGame: null, VIRTUAL_GAME_DIR: '/browser-games', window: { FS: {} },
    validateGameSelection: () => true, setStatus() {}, showLoading() {}, log() {}, formatBytes: String,
    mountBrowserGame: (_FS, source, name) => { assert.equal(source, file); mounted.push(name); return '/browser-games/' + name; },
    opfsPutGame: () => assert.fail('implicit cache copy'), refreshEmulatorGameBrowser() {},
    refreshLibrary() {}, updateStorageInfo() {}, showToast: text => messages.push(text),
  });
  assert.equal(await ctx.preloadGame({}), '/browser-games/game.iso');
  await ctx.loadGameAtRuntime(file);
  assert.equal(mounted.length, 2);
  assert.match(messages.at(-1), /仅本次载入/);
});

test('game read failures show the recovery panel once and retain the first actionable error', () => {
  const message = { textContent: '' }, recovery = { hidden: true }, statuses = [];
  let loadingHidden = 0;
  const ctx = load(['handleBrowserGameReadError', 'failRuntime'], {
    started: false, runtimeFailed: false, runtimeReady: true,
    window: { ModuleStartupWatchdog: 1 }, clearTimeout() {}, log() {},
    byId: id => id === 'runtimeFailureMessage' ? message : id === 'runtimeRecovery' ? recovery : null,
    hideLoading: () => loadingHidden++, setStatus: (text, kind) => statuses.push({ text, kind }),
  });
  const event = { detail: { path: '/browser-games/game.iso', message: 'File snapshot is no longer readable' } };
  ctx.handleBrowserGameReadError(event);
  assert.equal(recovery.hidden, true);
  ctx.started = true;
  ctx.handleBrowserGameReadError(event);
  assert.equal(ctx.runtimeFailed, true);
  assert.equal(ctx.runtimeReady, false);
  assert.equal(recovery.hidden, false);
  assert.match(message.textContent, /游戏文件读取失败/);
  assert.match(message.textContent, /已同步到本机的存档会保留/);
  assert.equal(statuses[0].kind, 'err');
  ctx.handleBrowserGameReadError(event);
  assert.equal(statuses.length, 1);
  assert.equal(loadingHidden, 1);
});
