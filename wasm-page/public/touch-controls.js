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
      setButtons(source, names, { replaceImmediately = false } = {}) {
        const indices = new Set(names.map(name => BUTTONS[name]).filter(Number.isInteger));
        const released = replaceImmediately ? new Set() : false;
        // A drag is continuous input: do not keep the old direction alive as a quick tap.
        // Other fingers (including their pending taps) still own their buttons.
        if (replaceImmediately) owners.forEach((sources, i) => {
          if (!indices.has(i) && sources.delete(source) && !sources.size) released.add(i);
        });
        indices.forEach(i => owners[i].add(source));
        buttons.set(source, indices);
        update(released);
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

  function dpadButtons(x, y, previous = []) {
    if (Math.hypot(x, y) < 0.2) return [];
    const names = [];
    const horizontal = x < 0 ? 'left' : 'right';
    const vertical = y < 0 ? 'up' : 'down';
    // A small angular hysteresis prevents a resting thumb flickering between sectors.
    const threshold = name => !previous.length ? 0.4142 : previous.includes(name) ? 0.3346 : 0.4986;
    if (Math.abs(x) >= Math.abs(y) * threshold(horizontal)) names.push(horizontal);
    if (Math.abs(y) >= Math.abs(x) * threshold(vertical)) names.push(vertical);
    return names;
  }

  function stickAxes(x, y) {
    const distance = Math.hypot(x, y);
    const deadZone = 0.12;
    if (distance <= deadZone) return [0, 0];
    const magnitude = Math.min(1, (distance - deadZone) / (1 - deadZone));
    return [x / distance * magnitude, y / distance * magnitude];
  }

  function mount({ element, canvas, state, onInteraction = () => canvas.focus({ preventScroll: true }) }) {
    const document = element.ownerDocument;
    const window = document.defaultView;
    const pointers = new Map();
    const listeners = [];
    const pulses = new Set();
    const stick = element.querySelector('[data-pad-stick]');
    const buttons = [...element.querySelectorAll('[data-pad-button]')];
    const geometryTargets = [element, canvas, stick, ...element.querySelectorAll('[data-pad-dpad]'), ...buttons]
      .filter(target => typeof target?.getBoundingClientRect === 'function');
    let enabled = false;
    let destroyed = false;
    let geometry = [];
    let stickRadius = 0;
    let stickPointer = null;
    let lastPointerTime = -Infinity;

    function listen(target, type, listener, options) {
      target.addEventListener(type, listener, options);
      listeners.push(() => target.removeEventListener(type, listener, options));
    }
    function render() {
      buttons.forEach(button => {
        const pressed = state.gamepad.buttons[BUTTONS[button.dataset.padButton]].pressed;
        button.classList.toggle('is-pressed', pressed);
        button.setAttribute('aria-pressed', String(pressed));
      });
      stick.style.setProperty('--stick-x', `${state.gamepad.axes[0] * stickRadius}px`);
      stick.style.setProperty('--stick-y', `${state.gamepad.axes[1] * stickRadius}px`);
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
    function refreshGeometry() {
      if (destroyed) return;
      // Measure on layout changes or a fresh touch, never on every pointermove.
      const next = geometryTargets.flatMap(target => {
        const rect = target.getBoundingClientRect();
        if (target === stick) stickRadius = Math.min(rect.width, rect.height) * 0.3;
        return [rect.left, rect.top, rect.width, rect.height];
      });
      // Pinch zoom, viewport panning and display-density changes can change
      // pointer coordinates even when the element's layout box stays the same.
      next.push(window.devicePixelRatio || 1, window.visualViewport?.scale || 1,
        window.visualViewport?.offsetLeft || 0, window.visualViewport?.offsetTop || 0);
      const changed = geometry.length > 0 && next.some((value, i) => value !== geometry[i]);
      geometry = next;
      if (changed) reset();
    }
    const layoutChanged = () => refreshGeometry();
    function move(event, pointer) {
      if (pointer.kind === 'button') {
        const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-pad-button]');
        state.setButtons(event.pointerId, target && element.contains(target) ? [target.dataset.padButton] : [],
          { replaceImmediately: true });
        return;
      }
      const x = (event.clientX - pointer.originX) / pointer.radius;
      const y = (event.clientY - pointer.originY) / pointer.radius;
      if (pointer.kind === 'stick') state.setAxes(event.pointerId, ...stickAxes(x, y));
      else {
        pointer.directions = dpadButtons(x, y, pointer.directions);
        state.setButtons(event.pointerId, pointer.directions, { replaceImmediately: true });
      }
    }
    listen(element, 'pointerdown', event => {
      if (!enabled || (event.pointerType === 'mouse' && event.button !== 0)) return;
      const control = event.target.closest('[data-pad-stick], [data-pad-dpad], [data-pad-button]');
      if (!control || !element.contains(control)) return;
      const dpad = control.closest('[data-pad-dpad]');
      const kind = control.hasAttribute('data-pad-stick') ? 'stick' : dpad ? 'dpad' : 'button';
      event.preventDefault();
      event.stopPropagation();
      refreshGeometry();
      if (kind === 'stick' && stickPointer !== null) return;
      const pointer = { control: dpad || control, kind };
      if (kind !== 'button') {
        const rect = pointer.control.getBoundingClientRect();
        pointer.radius = Math.max(1, Math.min(rect.width, rect.height) * (kind === 'stick' ? 0.3 : 0.5));
        // Anchor at this finger's landing point, so an off-centre touch starts neutral.
        pointer.originX = kind === 'stick' ? event.clientX : rect.left + rect.width / 2;
        pointer.originY = kind === 'stick' ? event.clientY : rect.top + rect.height / 2;
        pointer.directions = [];
      }
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
    listen(window, 'resize', layoutChanged);
    listen(window, 'orientationchange', layoutChanged);
    listen(document, 'scroll', layoutChanged, { capture: true, passive: true });
    listen(document, 'fullscreenchange', layoutChanged);
    listen(document, 'ppsspp-player-layout', layoutChanged);
    if (window.visualViewport) {
      listen(window.visualViewport, 'resize', layoutChanged);
      listen(window.visualViewport, 'scroll', layoutChanged, { passive: true });
    }
    if (typeof window.ResizeObserver === 'function') {
      const observer = new window.ResizeObserver(() => refreshGeometry());
      geometryTargets.forEach(target => observer.observe(target));
      listeners.push(() => observer.disconnect());
    }
    listen(document, 'visibilitychange', () => { if (document.hidden) reset(); });
    const unsubscribe = state.subscribe(render);
    element.hidden = true;
    refreshGeometry();
    render();
    return {
      setEnabled(value) {
        enabled = Boolean(value);
        if (!enabled) reset();
        element.hidden = !enabled;
        refreshGeometry();
        render();
      },
      destroy() { destroyed = true; enabled = false; reset(); element.hidden = true; unsubscribe(); listeners.forEach(remove => remove()); },
    };
  }
  root.PpssppTouchControls = Object.freeze({ BUTTONS, createState, dpadButtons, stickAxes, mount });
})(globalThis);
