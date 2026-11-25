// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of PPSSPW and is licensed under GNU AGPLv3 with Additional Terms (see LICENSE and LICENSE-ADDITIONAL_TERMS-zh-CN.md; ref: LICENSE-ADDITIONAL_TERMS-en.md).
/**
 * PPSSPW 待机欢迎屏背景动效引擎
 *
 * - 暗色模式 (Dark Mode)：经典光点网格（96 个节点、光点连线、鼠标引力场、呼吸透明度、点击增亮）
 * - 亮色模式 (Light Mode)：PSP XMB 纯净流体光波丝带（多束谐波流体丝带、柔和微光粒子、鼠标流体挠曲与平滑高斯波纹）
 *
 * 特性：
 * 1. 深度适配系统与昼夜切换开关，暗/亮模式交叉淡入淡出过渡；
 * 2. 挂载于 #idleOverlay 内部背景层，严格位于引导卡片与按钮之下（z-index: 0），覆盖完整滚动高度；
 * 3. 游戏启动后、标签页隐藏或系统启用减弱动态效果时真正停止 requestAnimationFrame，零后台消耗，并在恢复待机时自动续播。
 */

type ThemeMode = 'dark' | 'light';

interface DarkNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  phase: number;
  speed: number;
  offx: number;
  offy: number;
  px: number;
  py: number;
  a: number;
}

interface LightMote {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  phase: number;
  speed: number;
  alpha: number;
  baseAlpha: number;
}

interface Ripple {
  x: number;
  y: number;
  r: number;
  maxR: number;
  alpha: number;
}

export function mountIdleMotion(): () => void {
  const idle = document.getElementById('idleOverlay');
  if (!idle) return () => {};

  function applyCanvasStyles(c: HTMLCanvasElement) {
    c.style.position = 'absolute';
    c.style.top = '0';
    c.style.left = '0';
    c.style.pointerEvents = 'none';
    c.style.zIndex = '0';
    c.style.background = 'transparent';
    c.style.border = 'none';
    c.style.borderRadius = '0';
    c.style.boxShadow = 'none';
    c.style.aspectRatio = 'auto';
    c.style.maxWidth = 'none';
    c.style.maxHeight = 'none';
    c.style.display = 'block';
  }

  let canvas = idle.querySelector<HTMLCanvasElement>('canvas.idle-motion-canvas');
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.className = 'idle-motion-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    applyCanvasStyles(canvas);
    idle.insertBefore(canvas, idle.firstChild);
  } else {
    applyCanvasStyles(canvas);
  }

  const ctx = canvas.getContext('2d');
  if (!ctx) return () => {};

  const reducedMotion: MediaQueryList | null =
    typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const colorSchemeMedia: MediaQueryList | null =
    typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  let animId = 0;
  let isRunning = true;
  let lastFrameTime = 0;
  let pressTimer = 0;
  let width = 0;
  let height = 0;
  let dpr = 1;

  const pointer = { x: -9999, y: -9999, active: false, pressed: false };

  const DARK_COUNT = 96;
  const DARK_LINK = 104;
  const DARK_PULL = 170;
  let darkNodes: DarkNode[] = [];

  const LIGHT_MOTE_COUNT = 24;
  let lightMotes: LightMote[] = [];
  const ripples: Ripple[] = [];

  function getCurrentTheme(): ThemeMode {
    const docTheme = document.documentElement.dataset['theme'];
    if (docTheme === 'dark') return 'dark';
    if (docTheme === 'light') return 'light';
    return colorSchemeMedia?.matches ? 'dark' : 'light';
  }

  let themeMix = getCurrentTheme() === 'light' ? 1 : 0;

  function seedDark() {
    darkNodes = [];
    const cols = 14;
    const rows = 8;
    for (let i = 0; i < DARK_COUNT; i++) {
      const cx = ((i % cols) + 0.5) / cols;
      const cy = (Math.floor(i / cols) + 0.5) / rows;
      const x = (cx + (Math.random() - 0.5) * 0.2) * width;
      const y = (cy + (Math.random() - 0.5) * 0.24) * height;
      const phase = Math.random() * Math.PI * 2;
      const speed = 0.1 + Math.random() * 0.16;
      darkNodes.push({
        x,
        y,
        vx: (Math.random() - 0.5) * 0.18,
        vy: (Math.random() - 0.5) * 0.18,
        r: 0.8 + Math.random() * 1.1,
        phase,
        speed,
        offx: 0,
        offy: 0,
        px: x,
        py: y,
        a: 0.22 + 0.78 * (0.5 + 0.5 * Math.sin(phase)),
      });
    }
  }

  function seedLight() {
    lightMotes = [];
    for (let i = 0; i < LIGHT_MOTE_COUNT; i++) {
      const baseAlpha = 0.16 + Math.random() * 0.24;
      lightMotes.push({
        x: Math.random() * width,
        y: height * 0.3 + Math.random() * (height * 0.6),
        vx: 0.12 + Math.random() * 0.25,
        vy: (Math.random() - 0.5) * 0.12,
        r: 1.2 + Math.random() * 1.8,
        phase: Math.random() * Math.PI * 2,
        speed: 0.25 + Math.random() * 0.45,
        alpha: baseAlpha,
        baseAlpha,
      });
    }
  }

  function measureTargetSize() {
    const nextW = idle?.clientWidth || 0;
    const nextH = Math.max(idle?.clientHeight || 0, idle?.scrollHeight || 0);
    const nextDpr = Math.min(window.devicePixelRatio || 1, 2);
    return { nextW, nextH, nextDpr };
  }

  function resize() {
    if (!canvas || !idle) return;
    applyCanvasStyles(canvas);
    const { nextW, nextH, nextDpr } = measureTargetSize();
    if (nextW <= 0 || nextH <= 0) return;

    const oldW = width;
    const oldH = height;
    dpr = nextDpr;
    width = nextW;
    height = nextH;

    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);

    if (darkNodes.length === 0) {
      seedDark();
    } else if (oldW > 0 && oldH > 0 && (oldW !== width || oldH !== height)) {
      const sx = width / oldW;
      const sy = height / oldH;
      for (let i = 0; i < darkNodes.length; i++) {
        const n = darkNodes[i];
        n.x *= sx;
        n.y *= sy;
        n.px = n.x + n.offx;
        n.py = n.y + n.offy;
      }
    }

    if (lightMotes.length === 0) {
      seedLight();
    } else if (oldW > 0 && oldH > 0 && (oldW !== width || oldH !== height)) {
      const sx = width / oldW;
      const sy = height / oldH;
      for (let i = 0; i < lightMotes.length; i++) {
        lightMotes[i].x *= sx;
        lightMotes[i].y *= sy;
      }
    }
  }

  function isEmulatorStarted(): boolean {
    return (
      document.body.classList.contains('emulator-started') ||
      Boolean(idle?.hidden) ||
      idle?.style.display === 'none'
    );
  }

  function isReducedMotion(): boolean {
    return Boolean(reducedMotion?.matches);
  }

  function shouldAnimate(): boolean {
    return isRunning && !isEmulatorStarted() && !document.hidden && !isReducedMotion();
  }

  function renderDark(t: number, dt: number) {
    if (!ctx) return;

    const isPressed = pointer.pressed;
    const boost = isPressed ? 1.3 : 1.0;
    const ease = dt > 0 ? 1 - Math.pow(1 - 0.12, dt) : 0;

    for (let i = 0; i < darkNodes.length; i++) {
      const n = darkNodes[i];
      if (dt > 0) {
        n.x += n.vx * dt;
        n.y += n.vy * dt;
        if (n.x < -20) n.x = width + 20;
        else if (n.x > width + 20) n.x = -20;
        if (n.y < -20) n.y = height + 20;
        else if (n.y > height + 20) n.y = -20;
      }

      let tx = 0;
      let ty = 0;
      if (pointer.active) {
        const dx = pointer.x - n.x;
        const dy = pointer.y - n.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < DARK_PULL && d > 0.5) {
          let k = 1 - d / DARK_PULL;
          k = k * k * 26;
          tx = (dx / d) * k;
          ty = (dy / d) * k;
        }
      }
      if (ease > 0) {
        n.offx += (tx - n.offx) * ease;
        n.offy += (ty - n.offy) * ease;
      }
      n.px = n.x + n.offx;
      n.py = n.y + n.offy;
      n.a = 0.22 + 0.78 * (0.5 + 0.5 * Math.sin((t / 1000) * n.speed + n.phase));
    }

    ctx.lineWidth = 1;
    for (let i = 0; i < darkNodes.length; i++) {
      for (let j = i + 1; j < darkNodes.length; j++) {
        const a1 = darkNodes[i];
        const b1 = darkNodes[j];
        const dx = a1.px - b1.px;
        const dy = a1.py - b1.py;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d > DARK_LINK) continue;

        let alpha = (1 - d / DARK_LINK) * 0.42 * Math.min(a1.a, b1.a) * boost;
        if (pointer.active) {
          const mx = (a1.px + b1.px) / 2;
          const my = (a1.py + b1.py) / 2;
          const md = Math.sqrt((pointer.x - mx) * (pointer.x - mx) + (pointer.y - my) * (pointer.y - my));
          if (md < DARK_PULL) alpha += (1 - md / DARK_PULL) * 0.4;
        }
        ctx.strokeStyle = `rgba(140, 200, 255, ${Math.min(0.9, alpha).toFixed(3)})`;
        ctx.beginPath();
        ctx.moveTo(a1.px, a1.py);
        ctx.lineTo(b1.px, b1.py);
        ctx.stroke();
      }
    }

    for (let i = 0; i < darkNodes.length; i++) {
      const n = darkNodes[i];
      let near = 0;
      if (pointer.active) {
        const dx = pointer.x - n.px;
        const dy = pointer.y - n.py;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < DARK_PULL) near = 1 - d / DARK_PULL;
      }
      ctx.beginPath();
      ctx.arc(n.px, n.py, n.r * (1 + near * 1.6), 0, Math.PI * 2);
      ctx.fillStyle = `rgba(180, 225, 255, ${Math.min(1, (n.a + near * 0.5) * boost).toFixed(3)})`;
      ctx.fill();
    }
  }

  function renderLight(t: number, dt: number) {
    if (!ctx) return;

    const time = t * 0.001;
    const stepX = 8;

    // 1. 渲染主光波丝带（平滑多谐波曲面，带二维高斯包络交互波纹）
    const ribbonCount = 8;
    const baseY = height * 0.62;
    const topWave: { x: number; y: number }[] = [];
    const botWave: { x: number; y: number }[] = [];

    for (let k = 0; k < ribbonCount; k++) {
      const phi = k * 0.24;
      const strandAlpha = 0.06 + (1 - Math.abs(k - ribbonCount / 2) / (ribbonCount / 2)) * 0.16;

      ctx.beginPath();
      let isFirst = true;

      for (let x = 0; x <= width + stepX; x += stepX) {
        let y =
          baseY +
          Math.sin(x * 0.0022 + time * 0.8 + phi) * 36 +
          Math.cos(x * 0.0046 - time * 1.1 + phi * 1.2) * 18 +
          Math.sin(x * 0.008 + time * 1.5) * 8;

        if (pointer.active) {
          const dx = Math.abs(x - pointer.x);
          if (dx < 220) {
            const bell = (1 + Math.cos((Math.PI * dx) / 220)) * 0.5;
            y += bell * 26 * Math.sin(time * 2.8 + phi);
          }
        }

        for (let ri = 0; ri < ripples.length; ri++) {
          const rip = ripples[ri];
          const dx = x - rip.x;
          const dy = baseY - rip.y;
          const radial = Math.hypot(dx, dy);
          const u = radial - rip.r;
          if (Math.abs(u) < 90) {
            const env = Math.exp(-(u * u) / (2 * 26 * 26)) * Math.exp(-(dy * dy) / (2 * 260 * 260));
            y += Math.sin(u * 0.11) * env * (rip.alpha * 22);
          }
        }

        if (isFirst) {
          ctx.moveTo(x, y);
          isFirst = false;
        } else {
          ctx.lineTo(x, y);
        }

        if (k === 0) topWave.push({ x, y });
        if (k === ribbonCount - 1) botWave.push({ x, y });
      }

      ctx.strokeStyle = `rgba(9, 105, 218, ${strandAlpha.toFixed(3)})`;
      ctx.lineWidth = k === 0 || k === ribbonCount - 1 ? 1.6 : 1.0;
      ctx.stroke();
    }

    if (topWave.length > 0 && botWave.length > 0) {
      ctx.beginPath();
      ctx.moveTo(topWave[0].x, topWave[0].y);
      for (let i = 1; i < topWave.length; i++) {
        ctx.lineTo(topWave[i].x, topWave[i].y);
      }
      for (let i = botWave.length - 1; i >= 0; i--) {
        ctx.lineTo(botWave[i].x, botWave[i].y);
      }
      ctx.closePath();

      const ribbonGrad = ctx.createLinearGradient(0, baseY - 60, 0, baseY + 60);
      ribbonGrad.addColorStop(0, 'rgba(9, 105, 218, 0.06)');
      ribbonGrad.addColorStop(0.5, 'rgba(47, 129, 247, 0.03)');
      ribbonGrad.addColorStop(1, 'rgba(9, 105, 218, 0.005)');
      ctx.fillStyle = ribbonGrad;
      ctx.fill();
    }

    // 2. 渲染次级辅助波浪
    const secBaseY = height * 0.72;
    ctx.beginPath();
    let secFirst = true;
    for (let x = 0; x <= width + stepX; x += stepX) {
      const y = secBaseY + Math.sin(x * 0.003 - time * 0.6) * 20 + Math.cos(x * 0.006 + time * 0.9) * 12;
      if (secFirst) {
        ctx.moveTo(x, y);
        secFirst = false;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.strokeStyle = 'rgba(9, 105, 218, 0.12)';
    ctx.lineWidth = 1.2;
    ctx.stroke();

    // 3. 渲染微光粒子
    for (let i = 0; i < lightMotes.length; i++) {
      const m = lightMotes[i];
      if (dt > 0) {
        m.x += m.vx * dt;
        m.y += (m.vy + Math.sin(time * m.speed + m.phase) * 0.25) * dt;

        if (m.x > width + 20) {
          m.x = -20;
          m.y = height * 0.3 + Math.random() * (height * 0.6);
        }
        if (m.y < -20) m.y = height + 20;
        else if (m.y > height + 20) m.y = -20;
      }

      const pulse = 0.5 + 0.5 * Math.sin(time * m.speed * 2 + m.phase);
      const alpha = (m.baseAlpha * (0.6 + 0.4 * pulse)).toFixed(3);

      ctx.beginPath();
      ctx.arc(m.x, m.y, m.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(9, 105, 218, ${alpha})`;
      ctx.fill();
    }

    // 4. 绘制点击产生的平滑扩散涟漪
    for (let i = ripples.length - 1; i >= 0; i--) {
      const r = ripples[i];
      if (dt > 0) {
        r.r += 3.2 * dt;
        r.alpha *= Math.pow(0.945, dt);
      }
      if (r.r >= r.maxR || r.alpha < 0.01) {
        ripples.splice(i, 1);
        continue;
      }
      ctx.beginPath();
      ctx.arc(r.x, r.y, r.r, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(9, 105, 218, ${r.alpha.toFixed(3)})`;
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }
  }

  function drawFrame(t: number, dt: number) {
    if (!ctx || width <= 0 || height <= 0) return;
    ctx.clearRect(0, 0, width, height);

    const darkAlpha = 1 - themeMix;
    const lightAlpha = themeMix;

    if (darkAlpha > 0.001) {
      ctx.save();
      ctx.globalAlpha = darkAlpha;
      renderDark(t, dt);
      ctx.restore();
    }
    if (lightAlpha > 0.001) {
      ctx.save();
      ctx.globalAlpha = lightAlpha;
      renderLight(t, dt);
      ctx.restore();
    }
  }

  function step(t: number) {
    if (!shouldAnimate()) {
      animId = 0;
      lastFrameTime = 0;
      return;
    }

    const dt = lastFrameTime ? Math.min(Math.max((t - lastFrameTime) / 16.6667, 0.1), 2.5) : 1;
    lastFrameTime = t;

    const { nextW, nextH, nextDpr } = measureTargetSize();
    if (Math.abs(width - nextW) > 1 || Math.abs(height - nextH) > 1 || Math.abs(dpr - nextDpr) > 0.01) {
      resize();
    }

    const targetMix = getCurrentTheme() === 'light' ? 1 : 0;
    if (Math.abs(targetMix - themeMix) > 0.001) {
      const stepAmt = dt / 26;
      themeMix = targetMix > themeMix ? Math.min(1, themeMix + stepAmt) : Math.max(0, themeMix - stepAmt);
    } else {
      themeMix = targetMix;
    }

    drawFrame(t, dt);

    if (shouldAnimate()) {
      animId = requestAnimationFrame(step);
    } else {
      animId = 0;
      lastFrameTime = 0;
    }
  }

  function syncPlayback() {
    if (!isRunning || !canvas || !idle) return;
    if (isEmulatorStarted()) {
      if (animId) {
        cancelAnimationFrame(animId);
        animId = 0;
      }
      lastFrameTime = 0;
      canvas.style.opacity = '0';
      return;
    }

    canvas.style.opacity = '1';

    if (isReducedMotion()) {
      if (animId) {
        cancelAnimationFrame(animId);
        animId = 0;
      }
      lastFrameTime = 0;
      resize();
      themeMix = getCurrentTheme() === 'light' ? 1 : 0;
      drawFrame(0, 0);
      return;
    }

    if (!document.hidden) {
      if (!animId) {
        lastFrameTime = 0;
        animId = requestAnimationFrame(step);
      }
    } else if (animId) {
      cancelAnimationFrame(animId);
      animId = 0;
      lastFrameTime = 0;
    }
  }

  const updatePointerCoords = (e: PointerEvent) => {
    const rect = idle.getBoundingClientRect();
    pointer.x = e.clientX - rect.left + idle.scrollLeft;
    pointer.y = e.clientY - rect.top + idle.scrollTop;
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!idle || isEmulatorStarted() || isReducedMotion()) return;
    updatePointerCoords(e);
    pointer.active = true;
  };

  const onPointerDown = (e: PointerEvent) => {
    if (!idle || isEmulatorStarted() || isReducedMotion()) return;
    updatePointerCoords(e);
    pointer.active = true;
    pointer.pressed = true;

    if (getCurrentTheme() === 'light') {
      if (ripples.length >= 12) ripples.shift();
      ripples.push({
        x: pointer.x,
        y: pointer.y,
        r: 8,
        maxR: 240,
        alpha: 0.36,
      });
    }

    if (pressTimer) window.clearTimeout(pressTimer);
    pressTimer = window.setTimeout(() => {
      pressTimer = 0;
      pointer.pressed = false;
    }, 450);
  };

  const onPointerLeave = () => {
    pointer.active = false;
    pointer.pressed = false;
  };

  const onResizeOrScroll = () => {
    resize();
    if (isReducedMotion() && !isEmulatorStarted()) {
      themeMix = getCurrentTheme() === 'light' ? 1 : 0;
      drawFrame(0, 0);
    }
  };

  const onVisibilityChange = () => syncPlayback();
  const onReducedChange = () => syncPlayback();
  const onSchemeChange = () => {
    ripples.length = 0;
    if (isReducedMotion() && !isEmulatorStarted()) {
      themeMix = getCurrentTheme() === 'light' ? 1 : 0;
      drawFrame(0, 0);
    }
  };

  window.addEventListener('resize', onResizeOrScroll, { passive: true });
  idle.addEventListener('pointermove', onPointerMove, { passive: true });
  idle.addEventListener('pointerdown', onPointerDown, { passive: true });
  idle.addEventListener('pointerleave', onPointerLeave, { passive: true });
  document.addEventListener('visibilitychange', onVisibilityChange);

  if (reducedMotion) {
    if (typeof reducedMotion.addEventListener === 'function') {
      reducedMotion.addEventListener('change', onReducedChange);
    } else if (typeof reducedMotion.addListener === 'function') {
      reducedMotion.addListener(onReducedChange);
    }
  }
  if (colorSchemeMedia) {
    if (typeof colorSchemeMedia.addEventListener === 'function') {
      colorSchemeMedia.addEventListener('change', onSchemeChange);
    } else if (typeof colorSchemeMedia.addListener === 'function') {
      colorSchemeMedia.addListener(onSchemeChange);
    }
  }

  let resizeObserver: ResizeObserver | null = null;
  if (typeof ResizeObserver === 'function') {
    resizeObserver = new ResizeObserver(() => onResizeOrScroll());
    resizeObserver.observe(idle);
  }

  const themeObserver = new MutationObserver(() => {
    ripples.length = 0;
    if (isReducedMotion() && !isEmulatorStarted()) {
      themeMix = getCurrentTheme() === 'light' ? 1 : 0;
      drawFrame(0, 0);
    }
  });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  const bodyObserver = new MutationObserver(() => syncPlayback());
  bodyObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });

  const idleObserver = new MutationObserver(() => syncPlayback());
  idleObserver.observe(idle, { attributes: true, attributeFilter: ['hidden', 'style'] });

  resize();
  syncPlayback();

  return () => {
    isRunning = false;
    if (animId) cancelAnimationFrame(animId);
    if (pressTimer) window.clearTimeout(pressTimer);
    window.removeEventListener('resize', onResizeOrScroll);
    idle.removeEventListener('pointermove', onPointerMove);
    idle.removeEventListener('pointerdown', onPointerDown);
    idle.removeEventListener('pointerleave', onPointerLeave);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    if (reducedMotion) {
      if (typeof reducedMotion.removeEventListener === 'function') {
        reducedMotion.removeEventListener('change', onReducedChange);
      } else if (typeof reducedMotion.removeListener === 'function') {
        reducedMotion.removeListener(onReducedChange);
      }
    }
    if (colorSchemeMedia) {
      if (typeof colorSchemeMedia.removeEventListener === 'function') {
        colorSchemeMedia.removeEventListener('change', onSchemeChange);
      } else if (typeof colorSchemeMedia.removeListener === 'function') {
        colorSchemeMedia.removeListener(onSchemeChange);
      }
    }
    resizeObserver?.disconnect();
    themeObserver.disconnect();
    bodyObserver.disconnect();
    idleObserver.disconnect();
    if (canvas && canvas.parentNode) {
      canvas.parentNode.removeChild(canvas);
    }
  };
}
