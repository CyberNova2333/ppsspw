(function (root) {
  'use strict';

  const BUTTONS = Object.freeze({ cross: 0, circle: 1, square: 2, triangle: 3,
    l: 4, r: 5, select: 8, start: 9, up: 12, down: 13, left: 14, right: 15 });

  function createState({ now = () => performance.now(), index = 0,
    setTimeout: later = root.setTimeout.bind(root), clearTimeout: cancel = root.clearTimeout.bind(root) } = {}) {
    const gamepad = { id: 'PPSSPP Web Screen Controller', index, mapping: 'standard', connected: true,
      timestamp: now(), axes: [0, 0, 0, 0],
      buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })) };
    const buttons = new Map();
    const axes = new Map();
    const listeners = new Set();
    const pressedAt = Array(17).fill(0);
    const owners = Array.from({ length: 17 }, () => new Set());
    const pending = new Map();

    function update(immediate = false) {
      const held = new Set([...buttons.values()].flatMap(names => [...names]));
      let changed = false;
      gamepad.buttons.forEach((button, i) => {
        const down = held.has(i);
        if (down && pending.has(i)) { cancel(pending.get(i)); pending.delete(i); }
        // SDL polls once per frame. Preserve quick taps until at least one frame can observe them.
        const remaining = 60 - (now() - pressedAt[i]);
        const releaseNow = immediate === true || (immediate && immediate.has(i));
        if (!down && button.pressed && !releaseNow && remaining > 0) {
          if (!pending.has(i)) pending.set(i, later(() => { pending.delete(i); update(); }, Math.ceil(remaining)));
          return;
        }
        if (!down && pending.has(i)) { cancel(pending.get(i)); pending.delete(i); }
        if (button.pressed === down) return;
        if (down) pressedAt[i] = now();
        else owners[i].clear();
        Object.assign(button, { pressed: down, touched: down, value: down ? 1 : 0 });
        changed = true;
      });
      const current = [...axes.values()].at(-1) || [0, 0];
      for (let i = 0; i < 2; i++) {
        if (gamepad.axes[i] !== current[i]) { gamepad.axes[i] = current[i]; changed = true; }
      }
      if (changed) {
        gamepad.timestamp = Math.max(gamepad.timestamp + 0.001, now());
        listeners.forEach(listener => listener(gamepad));
      }
    }
    return {
      gamepad,
      setButtons(source, names) {
        const indices = new Set(names.map(name => BUTTONS[name]).filter(Number.isInteger));
        indices.forEach(i => owners[i].add(source));
        buttons.set(source, indices);
        update();
      },
      setAxes(source, x, y) {
        const length = Math.max(1, Math.hypot(x, y));
        axes.delete(source);
        axes.set(source, [x / length, y / length]);
        update();
      },
      release(source, { immediate = false } = {}) {
        const canceled = immediate ? new Set() : false;
        if (immediate) owners.forEach((sources, i) => {
          if (sources.delete(source) && !sources.size) canceled.add(i);
        });
        buttons.delete(source); axes.delete(source); update(canceled);
      },
      reset() { buttons.clear(); axes.clear(); pending.forEach(cancel); pending.clear(); owners.forEach(sources => sources.clear()); update(true); },
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    };
  }

  function dpadButtons(x, y) {
    if (Math.hypot(x, y) < 0.2) return [];
    const names = [];
    if (Math.abs(x) >= Math.abs(y) * 0.4142) names.push(x < 0 ? 'left' : 'right');
    if (Math.abs(y) >= Math.abs(x) * 0.4142) names.push(y < 0 ? 'up' : 'down');
    return names;
  }

  function mount({ element, canvas, state, onInteraction = () => canvas.focus({ preventScroll: true }) }) {
    const document = element.ownerDocument;
    const window = document.defaultView;
    const pointers = new Map();
    const listeners = [];
    const pulses = new Set();
    const stick = element.querySelector('[data-pad-stick]');
    let enabled = false;
    let stickPointer = null;
    let lastPointerTime = -Infinity;

    function listen(target, type, listener, options) {
      target.addEventListener(type, listener, options);
      listeners.push(() => target.removeEventListener(type, listener, options));
    }
    function render() {
      element.querySelectorAll('[data-pad-button]').forEach(button => {
        const pressed = state.gamepad.buttons[BUTTONS[button.dataset.padButton]].pressed;
        button.classList.toggle('is-pressed', pressed);
        button.setAttribute('aria-pressed', String(pressed));
      });
      const radius = stick.getBoundingClientRect().width * 0.3;
      stick.style.setProperty('--stick-x', `${state.gamepad.axes[0] * radius}px`);
      stick.style.setProperty('--stick-y', `${state.gamepad.axes[1] * radius}px`);
      stick.classList.toggle('is-pressed', stickPointer !== null);
    }
    function releasePointer(id, immediate = false) {
      const pointer = pointers.get(id);
      if (!pointer) return;
      pointers.delete(id);
      if (stickPointer === id) stickPointer = null;
      state.release(id, { immediate });
      if (pointer.control.hasPointerCapture?.(id)) pointer.control.releasePointerCapture(id);
      render();
    }
    function reset() {
      for (const id of [...pointers.keys()]) releasePointer(id, true);
      pulses.forEach(timer => window.clearTimeout(timer));
      pulses.clear();
      state.reset();
      render();
    }
    function move(event, pointer) {
      if (pointer.kind === 'button') {
        const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-pad-button]');
        state.setButtons(event.pointerId, target && element.contains(target) ? [target.dataset.padButton] : []);
        return;
      }
      const rect = pointer.control.getBoundingClientRect();
      const radius = Math.min(rect.width, rect.height) * (pointer.kind === 'stick' ? 0.3 : 0.5);
      const x = (event.clientX - rect.left - rect.width / 2) / radius;
      const y = (event.clientY - rect.top - rect.height / 2) / radius;
      if (pointer.kind === 'stick') state.setAxes(event.pointerId, x, y);
      else state.setButtons(event.pointerId, dpadButtons(x, y));
    }
    listen(element, 'pointerdown', event => {
      if (!enabled || (event.pointerType === 'mouse' && event.button !== 0)) return;
      const control = event.target.closest('[data-pad-stick], [data-pad-dpad], [data-pad-button]');
      if (!control || !element.contains(control)) return;
      const dpad = control.closest('[data-pad-dpad]');
      const kind = control.hasAttribute('data-pad-stick') ? 'stick' : dpad ? 'dpad' : 'button';
      event.preventDefault();
      event.stopPropagation();
      if (kind === 'stick' && stickPointer !== null) return;
      const pointer = { control: dpad || control, kind };
      pointers.set(event.pointerId, pointer);
      if (kind === 'stick') stickPointer = event.pointerId;
      lastPointerTime = window.performance.now();
      pointer.control.setPointerCapture(event.pointerId);
      onInteraction();
      move(event, pointer);
      render();
    });
    listen(element, 'pointermove', event => {
      const pointer = pointers.get(event.pointerId);
      if (!pointer) return;
      event.preventDefault();
      event.stopPropagation();
      move(event, pointer);
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      listen(element, type, event => {
        if (!pointers.has(event.pointerId)) return;
        event.preventDefault();
        event.stopPropagation();
        releasePointer(event.pointerId, type !== 'pointerup');
      });
    }
    listen(element, 'click', event => {
      const button = event.target.closest('[data-pad-button]');
      if (!enabled || !button || !element.contains(button)) return;
      event.preventDefault();
      event.stopPropagation();
      // Keyboard/assistive activation has no pointer; compatibility mouse clicks must not repeat taps.
      if (event.detail !== 0 || window.performance.now() - lastPointerTime < 500) return;
      onInteraction();
      const source = Symbol('activation');
      state.setButtons(source, [button.dataset.padButton]);
      const timer = window.setTimeout(() => { pulses.delete(timer); state.release(source); }, 80);
      pulses.add(timer);
    });
    listen(element, 'contextmenu', event => event.preventDefault());
    listen(window, 'blur', reset);
    listen(window, 'pagehide', reset);
    listen(window, 'resize', reset);
    listen(window, 'orientationchange', reset);
    listen(document, 'visibilitychange', () => { if (document.hidden) reset(); });
    const unsubscribe = state.subscribe(render);
    element.hidden = true;
    render();
    return {
      setEnabled(value) {
        enabled = Boolean(value);
        if (!enabled) reset();
        element.hidden = !enabled;
        render();
      },
      destroy() { enabled = false; reset(); element.hidden = true; unsubscribe(); listeners.forEach(remove => remove()); },
    };
  }
  root.PpssppTouchControls = Object.freeze({ BUTTONS, createState, dpadButtons, mount });
})(globalThis);
