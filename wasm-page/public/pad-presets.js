// SPDX-License-Identifier: AGPL-3.0-only
// Local screen controller layouts. The built-in layout remains owned by responsive CSS.
(function (root) {
  'use strict';
  const STORE = 'ppsspw.touch-presets.v1';
  const labels = { cross: '×', circle: '○', square: '□', triangle: '△', up: '↑', down: '↓', left: '←', right: '→',
    l: 'L', r: 'R', select: 'SELECT', start: 'START', dpad: '十字键', stick: '摇杆' };
  const directions = ['up', 'left', 'right', 'down'];
  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
  const travel = (offset, length) => length > 0 ? clamp(offset / length, 0, 1) : .5;
  const uid = () => root.crypto.randomUUID();
  const keyboard = root.PpssppTouchControls.keyboard;

  function label(binding) {
    const key = keyboard.get(binding);
    return key ? key.code.replace(/^Key|^Digit/, '') : labels[binding];
  }
  function readStore() {
    const empty = { active: '', presets: [] };
    const raw = localStorage.getItem(STORE);
    if (!raw) return empty;
    let data;
    try { data = JSON.parse(raw); } catch { return empty; }
    if (!Array.isArray(data?.presets)) return empty;
    const seen = new Set();
    const presets = data.presets.filter(p => {
      if (!p || typeof p.id !== 'string' || !p.id || seen.has(p.id) || typeof p.name !== 'string' || !Array.isArray(p.controls)) return false;
      const ids = new Set(); let sticks = 0;
      for (const c of p.controls) {
        if (!c || typeof c.id !== 'string' || ids.has(c.id) || (!Object.hasOwn(labels, c.binding) && !keyboard.has(c.binding))
          || ![c.x, c.y, c.size, c.aspect].every(Number.isFinite) || c.x < 0 || c.x > 1 || c.y < 0 || c.y > 1
          || c.size < 32 || c.size > 240 || c.aspect <= 0 || (c.binding === 'stick' && ++sticks > 1)) return false;
        ids.add(c.id);
      }
      seen.add(p.id); return true;
    });
    return { active: seen.has(data.active) ? data.active : '', presets };
  }
  function position(node, c) {
    node.style.left = c.x * 100 + '%';
    node.style.top = c.y * 100 + '%';
    node.style.transform = 'translate(' + (-100 * c.x) + '%, ' + (-100 * c.y) + '%)';
    node.style.width = 'min(100%, ' + c.size + 'px)';
    node.style.height = 'min(100%, ' + c.size / c.aspect + 'px)';
  }
  function withStorageLock(action) {
    return navigator.locks ? navigator.locks.request(STORE, action) : action();
  }
  async function clear() {
    await withStorageLock(() => localStorage.removeItem(STORE));
    root.dispatchEvent(new Event('ppsspp-pad-presets-cleared'));
  }
  function mount({ element, replaceLayout, onEditing, notify }) {
    const by = id => document.getElementById(id);
    const dialog = by('padEditor'), board = by('padPreview'), frame = by('padBoardFrame');
    const presetSelect = by('padPreset'), bindingSelect = by('padBinding'), selection = by('padSelection');
    const original = [...element.children];
    const originalButton = new Map([...element.querySelectorAll('[data-pad-button]')].map(b => [b.dataset.padButton, b]));
    const dpad = element.querySelector('[data-pad-dpad]'), stick = element.querySelector('[data-pad-stick]');
    const status = by('padPresetStatus'), message = by('padEditorStatus');
    let saved = { active: '', presets: [] }, applied = '';
    let draft = null, source = null, selected = null, dragging = null, busy = false;
    let width = 1, height = 1, scale = 1, opener = null;

    function option(text, value) { return new Option(text, value); }
    for (const [title, keys] of [['PSP 控件', Object.keys(labels)], ['键盘按键', [...keyboard.keys()]]]) {
      const group = document.createElement('optgroup');
      group.label = title;
      for (const key of keys) group.append(option(label(key), key));
      bindingSelect.append(group);
    }
    function liveControl(c) {
      let node;
      if (c.binding === 'dpad' || c.binding === 'stick') {
        node = (c.binding === 'dpad' ? dpad : stick).cloneNode(true);
      } else {
        node = originalButton.get(c.binding)?.cloneNode(true) || document.createElement('button');
        node.type = 'button'; node.dataset.padButton = c.binding;
        if (keyboard.has(c.binding)) {
          node.textContent = label(c.binding);
          node.setAttribute('aria-label', '键盘 ' + label(c.binding));
        }
      }
      node.classList.remove('is-pressed');
      node.classList.add('pad-placement');
      position(node, c);
      return node;
    }
    function refresh() {
      try { saved = readStore(); }
      catch (error) { status.textContent = '无法读取本机预设：' + error.message; }
      presetSelect.replaceChildren(option('内置布局', ''), ...saved.presets.map(p => option(p.name, p.id)));
      presetSelect.value = saved.active;
      by('padDeletePreset').disabled = !saved.active;
      const active = saved.presets.find(p => p.id === saved.active);
      const layout = active ? JSON.stringify(active.controls) : '';
      if (layout !== applied) {
        replaceLayout(active ? active.controls.map(liveControl) : original);
        applied = layout;
      }
    }
    async function write(change, feedback) {
      if (busy) return false;
      busy = true;
      try {
        const commit = () => {
          const store = readStore();
          change(store);
          localStorage.setItem(STORE, JSON.stringify(store));
        };
        await withStorageLock(commit);
        refresh(); status.textContent = feedback;
        return true;
      } catch (error) {
        refresh();
        (dialog.open ? message : status).textContent = '未保存：' + error.message;
        return false;
      } finally { busy = false; }
    }

    // Measure the actual responsive built-in deck, including the compact portrait layout.
    function measure(withControls) {
      const probe = element.cloneNode(false);
      probe.removeAttribute('id'); probe.hidden = false; probe.style.visibility = 'hidden';
      probe.append(...original.map(node => node.cloneNode(true)));
      const visible = document.body.classList.contains('touch-gamepad-visible');
      document.body.classList.add('touch-gamepad-visible');
      element.parentElement.append(probe);
      try {
        const area = probe.getBoundingClientRect();
        width = Math.max(1, area.width); height = Math.max(1, area.height);
        if (!withControls) return;
        return [...probe.querySelectorAll('[data-pad-stick], [data-pad-dpad], [data-pad-button]')]
          .filter(e => !e.parentElement.closest('[data-pad-dpad]')).map(e => {
            const r = e.getBoundingClientRect();
            const binding = e.dataset.padButton || (e.hasAttribute('data-pad-stick') ? 'stick' : 'dpad');
            return { id: uid(), binding, x: travel(r.left - area.left, width - r.width),
              y: travel(r.top - area.top, height - r.height), size: clamp(Math.round(r.width), 32, 240),
              aspect: r.width / Math.max(1, r.height) };
          });
      } finally {
        probe.remove(); document.body.classList.toggle('touch-gamepad-visible', visible);
      }
    }
    function fit() {
      if (!dialog.open) return;
      scale = Math.min(frame.clientWidth / width, frame.clientHeight / height);
      board.style.width = width + 'px'; board.style.height = height + 'px';
      board.style.transform = 'translate(-50%, -50%) scale(' + scale + ')';
    }
    function current() { return draft?.find(c => c.id === selected); }
    function inspector() {
      const c = current();
      by('padProperties').disabled = !c;
      selection.disabled = !draft.length;
      selection.replaceChildren(...draft.map((v, i) => option((i + 1) + ' · ' + label(v.binding), v.id)));
      selection.value = selected || '';
      by('padSplit').hidden = c?.binding !== 'dpad';
      by('padBindingHint').hidden = !keyboard.has(c?.binding);
      if (!c) return;
      bindingSelect.value = c.binding;
      bindingSelect.querySelector('[value="stick"]').disabled = draft.some(v => v !== c && v.binding === 'stick');
      by('padSize').value = c.size;
      by('padSizeValue').value = c.size + ' px';
      by('padX').value = Math.round(c.x * 100); by('padY').value = Math.round(c.y * 100);
    }
    function redraw() {
      board.replaceChildren(...draft.map(c => {
        const node = document.createElement('button'); node.type = 'button';
        node.className = 'pad-edit-key'; node.dataset.control = c.id; node.dataset.kind = c.binding;
        node.setAttribute('aria-label', label(c.binding));
        if (c.binding === 'dpad') {
          for (const direction of directions) {
            const cap = document.createElement('span'); cap.textContent = labels[direction];
            cap.className = 'pad-arrow-' + direction; node.append(cap);
          }
        } else if (c.binding !== 'stick') node.textContent = label(c.binding);
        node.setAttribute('aria-pressed', String(selected === c.id));
        position(node, c);
        return node;
      }));
      inspector(); fit();
    }
    function pick(id) {
      selected = id;
      for (const n of board.children) n.setAttribute('aria-pressed', String(n.dataset.control === id));
      inspector();
    }
    function uniqueName(base) {
      let name = base, n = 2;
      while (saved.presets.some(p => p.name === name)) name = base + ' ' + n++;
      return name;
    }
    function open(button) {
      if (dialog.open) return;
      opener = button;
      refresh(); source = saved.presets.find(p => p.id === saved.active) || null;
      const defaults = measure(!source);
      draft = source ? structuredClone(source.controls) : defaults;
      selected = draft[0]?.id; message.textContent = '';
      by('padName').value = source?.name || uniqueName('我的布局');
      by('padCopy').hidden = !source;
      dialog.showModal(); onEditing(true); redraw();
    }
    function close() { if (!busy) dialog.close(); }
    dialog.addEventListener('cancel', e => { if (busy) e.preventDefault(); });
    dialog.addEventListener('close', () => {
      if (dialog.open) return;
      dragging = null; draft = null; onEditing(false);
      (opener?.getClientRects().length ? opener : by('fsMenuToggle')).focus({ preventScroll: true });
    });
    by('padEdit').onclick = e => open(e.currentTarget);
    by('fsPadEdit').onclick = e => open(e.currentTarget);
    by('padCancel').onclick = close;
    async function save(copy) {
      const name = by('padName').value.trim();
      if (!name) { message.textContent = '请输入预设名称。'; by('padName').focus(); return; }
      const id = source && !copy ? source.id : uid();
      const preset = { id, name: copy && name === source.name ? uniqueName(name + ' 副本') : name, controls: structuredClone(draft) };
      if (await write(store => {
        const index = store.presets.findIndex(p => p.id === id);
        if (source && !copy && JSON.stringify(store.presets[index]) !== JSON.stringify(source))
          throw new Error('此预设已在其他页面变更，请另存为。');
        if (store.presets.some(p => p.id !== id && p.name === preset.name)) throw new Error('已有同名预设，请换一个名称。');
        if (index < 0) store.presets.push(preset); else store.presets[index] = preset;
        store.active = id;
      }, '已使用本机预设「' + preset.name + '」。')) {
        close(); notify('已保存并使用「' + preset.name + '」。');
      }
    }
    by('padSave').onclick = () => save(false); by('padCopy').onclick = () => save(true);
    presetSelect.onchange = () => {
      const id = presetSelect.value;
      void write(store => {
        if (id && !store.presets.some(p => p.id === id)) throw new Error('预设已删除。');
        store.active = id;
      }, '已切换按键预设。');
    };
    by('padDeletePreset').onclick = () => {
      const p = saved.presets.find(v => v.id === saved.active);
      if (!p || !root.confirm('删除按键预设「' + p.name + '」？')) return;
      void write(store => {
        store.presets = store.presets.filter(v => v.id !== p.id);
        if (store.active === p.id) store.active = '';
      }, '已删除预设。');
    };
    by('padAdd').onclick = () => {
      const c = { id: uid(), binding: 'cross', x: .5, y: .5, size: 48, aspect: 1 };
      draft.push(c); selected = c.id; redraw();
    };
    by('padRemove').onclick = () => {
      const index = draft.indexOf(current());
      draft.splice(index, 1); selected = draft[Math.min(index, draft.length - 1)]?.id; redraw();
    };
    by('padSplit').onclick = () => {
      const c = current(), size = clamp(Math.round(c.size / 3), 32, 240);
      const x = c.x * (width - c.size), y = c.y * (height - c.size);
      const keys = directions.map((binding, i) => ({ id: uid(), binding, size, aspect: 1,
        x: travel(x + [1, 0, 2, 1][i] * c.size / 3, width - size),
        y: travel(y + [0, 1, 1, 2][i] * c.size / 3, height - size) }));
      draft.splice(draft.indexOf(c), 1, ...keys); selected = keys[0].id; redraw();
    };
    selection.onchange = () => pick(selection.value);
    bindingSelect.onchange = () => {
      const c = current(), old = c.binding; c.binding = bindingSelect.value;
      if ([old, c.binding].some(k => k === 'stick' || k === 'dpad')) {
        c.size = c.binding === 'stick' ? 80 : c.binding === 'dpad' ? 132 : 48; c.aspect = 1;
      }
      redraw();
    };
    by('padSize').oninput = e => {
      const c = current(); c.size = Number(e.target.value);
      position(board.children[draft.indexOf(c)], c); by('padSizeValue').value = c.size + ' px';
    };
    for (const [id, axis] of [['padX', 'x'], ['padY', 'y']]) by(id).onchange = e => {
      const c = current();
      if (Number.isFinite(e.target.valueAsNumber)) c[axis] = clamp(e.target.valueAsNumber / 100, 0, 1);
      position(board.children[draft.indexOf(c)], c); inspector();
    };
    board.addEventListener('pointerdown', e => {
      const node = e.target.closest('[data-control]');
      if (!node || dragging || e.button !== 0) return;
      e.preventDefault(); pick(node.dataset.control); node.focus({ preventScroll: true });
      const c = current(), r = node.getBoundingClientRect();
      dragging = { pointer: e.pointerId, node, c, dx: e.clientX - r.left, dy: e.clientY - r.top };
      node.setPointerCapture(e.pointerId);
    });
    board.addEventListener('pointermove', e => {
      if (e.pointerId !== dragging?.pointer) return;
      const { c, node, dx, dy } = dragging, area = board.getBoundingClientRect(), r = node.getBoundingClientRect();
      c.x = travel(e.clientX - dx - area.left, area.width - r.width);
      c.y = travel(e.clientY - dy - area.top, area.height - r.height);
      position(node, c);
      by('padX').value = Math.round(c.x * 100); by('padY').value = Math.round(c.y * 100);
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) board.addEventListener(type, e => {
      if (dragging?.pointer === e.pointerId) dragging = null;
    });
    board.addEventListener('click', e => { if (e.target.dataset.control) pick(e.target.dataset.control); });
    new ResizeObserver(fit).observe(frame);
    root.addEventListener('resize', () => { if (dialog.open) { dragging = null; measure(false); fit(); } });
    root.addEventListener('ppsspp-pad-presets-cleared', refresh);
    root.addEventListener('storage', e => { if (!e.key || e.key === STORE) refresh(); });
    refresh();
  }
  root.PpssppPadPresets = { mount, clear };
})(globalThis);
