/**
 * PPSSPW 待机欢迎屏背景动效引擎
 *
 * - 暗色模式 (Dark Mode)：经典光点网格（96 个节点、光点连线、鼠标引力场、呼吸透明度、点击增亮）
 * - 亮色模式 (Light Mode)：PSP XMB 纯净流体光波丝带（多束谐波流体丝带、柔和微光粒子、鼠标流体挠曲与波纹涟漪）
 *
 * 特性：
 * 1. 深度适配系统及按钮切换的白天/黑夜主题；
 * 2. 挂载于 #idleOverlay 内部背景层，严格位于引导卡片与按钮之下（z-index: 0），绝不遮挡文字；
 * 3. 游戏启动后或待机层隐藏时立即休眠并暂停 requestAnimationFrame，释放 GPU/CPU。
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
    c.style.width = '100%';
    c.style.height = '100%';
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

  // 创建并注入背景 Canvas
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

  let animId = 0;
  let isRunning = true;
  let width = 0;
  let height = 0;
  let dpr = 1;

  const pointer = { x: -9999, y: -9999, active: false, pressed: false };

  // ==========================================
  // 暗色模式状态与初始化
  // ==========================================
  const DARK_COUNT = 96;
  const DARK_LINK = 104;
  const DARK_PULL = 170;
  let darkNodes: DarkNode[] = [];

  function seedDark() {
    darkNodes = [];
    const cols = 14;
    const rows = 8;
    for (let i = 0; i < DARK_COUNT; i++) {
      const cx = ((i % cols) + 0.5) / cols;
      const cy = (Math.floor(i / cols) + 0.5) / rows;
      darkNodes.push({
        x: (cx + (Math.random() - 0.5) * 0.2) * width,
        y: (cy + (Math.random() - 0.5) * 0.24) * height,
        vx: (Math.random() - 0.5) * 0.18,
        vy: (Math.random() - 0.5) * 0.18,
        r: 0.8 + Math.random() * 1.1,
        phase: Math.random() * Math.PI * 2,
        speed: 0.1 + Math.random() * 0.16,
        offx: 0,
        offy: 0,
        px: 0,
        py: 0,
        a: 0
      });
    }
  }

  // ==========================================
  // 亮色模式状态与初始化 (PSP XMB 纯净流体光波丝带 + 柔和光尘)
  // ==========================================
  const LIGHT_MOTE_COUNT = 24;
  let lightMotes: LightMote[] = [];
  const ripples: Ripple[] = [];

  function seedLight() {
    lightMotes = [];
    for (let i = 0; i < LIGHT_MOTE_COUNT; i++) {
      const baseAlpha = 0.16 + Math.random() * 0.24;
      lightMotes.push({
        x: Math.random() * width,
        y: height * 0.3 + Math.random() * (height * 0.6),
        vx: 0.12 + Math.random() * 0.25, // 顺着流体方向自左向右轻柔流动
        vy: (Math.random() - 0.5) * 0.12,
        r: 1.2 + Math.random() * 1.8,
        phase: Math.random() * Math.PI * 2,
        speed: 0.25 + Math.random() * 0.45,
        alpha: baseAlpha,
        baseAlpha
      });
    }
  }

  function resize() {
    if (!canvas || !idle) return;
    applyCanvasStyles(canvas);
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = idle.clientWidth;
    height = idle.clientHeight;
    if (width <= 0 || height <= 0) return;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);

    seedDark();
    seedLight();
  }

  function getCurrentTheme(): ThemeMode {
    const docTheme = document.documentElement.dataset['theme'];
    if (docTheme === 'dark') return 'dark';
    if (docTheme === 'light') return 'light';
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function isEmulatorStarted(): boolean {
    return document.body.classList.contains('emulator-started') || Boolean(idle?.hidden) || idle?.style.display === 'none';
  }

  // ==========================================
  // 暗色模式渲染循环 (经典光点星空网格)
  // ==========================================
  function renderDark(t: number) {
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);

    const isPressed = pointer.pressed;
    const boost = isPressed ? 1.3 : 1.0;

    for (let i = 0; i < darkNodes.length; i++) {
      const n = darkNodes[i];
      n.x += n.vx;
      n.y += n.vy;
      if (n.x < -20) n.x = width + 20;
      else if (n.x > width + 20) n.x = -20;
      if (n.y < -20) n.y = height + 20;
      else if (n.y > height + 20) n.y = -20;

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
      n.offx += (tx - n.offx) * 0.12;
      n.offy += (ty - n.offy) * 0.12;
      n.px = n.x + n.offx;
      n.py = n.y + n.offy;
      n.a = 0.22 + 0.78 * (0.5 + 0.5 * Math.sin((t / 1000) * n.speed + n.phase));
    }

    // 绘制连线
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

    // 绘制光点
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

  // ==========================================
  // 亮色模式渲染循环 (PSP XMB 纯净流体多谐波光波丝带)
  // ==========================================
  function renderLight(t: number) {
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);

    const time = t * 0.001;
    const stepX = 14;

    // 1. 渲染主光波丝带（多条谐波织丝形成 3D 丝带曲面效果）
    const ribbonCount = 8;
    const baseY = height * 0.62;

    // 存储首尾波浪点坐标以生成渐变充气曲面
    const topWave: { x: number; y: number }[] = [];
    const botWave: { x: number; y: number }[] = [];

    // 计算采样点并绘制丝带多股发丝
    for (let k = 0; k < ribbonCount; k++) {
      const phi = k * 0.24;
      const strandAlpha = 0.06 + (1 - Math.abs(k - ribbonCount / 2) / (ribbonCount / 2)) * 0.16;

      ctx.beginPath();
      let isFirst = true;

      for (let x = 0; x <= width + stepX; x += stepX) {
        // 多谐波正弦组合，展现 PSP XMB 特有的波带张力
        let y =
          baseY +
          Math.sin(x * 0.0022 + time * 0.8 + phi) * 36 +
          Math.cos(x * 0.0046 - time * 1.1 + phi * 1.2) * 18 +
          Math.sin(x * 0.008 + time * 1.5) * 8;

        // 鼠标流体引力凸起（靠近光标产生平滑膨胀高斯扰动）
        if (pointer.active) {
          const dx = Math.abs(x - pointer.x);
          if (dx < 220) {
            const bell = (1 + Math.cos((Math.PI * dx) / 220)) * 0.5;
            y += bell * 26 * Math.sin(time * 2.8 + phi);
          }
        }

        // 点击产生的涟漪影响波峰
        for (let ri = 0; ri < ripples.length; ri++) {
          const rip = ripples[ri];
          const distToRipple = Math.abs(x - rip.x);
          if (Math.abs(distToRipple - rip.r) < 32) {
            y += Math.sin((distToRipple - rip.r) * 0.2) * (rip.alpha * 24);
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

    // 在丝带外缘之间填充轻盈的淡蓝羽化渐变
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

    // 2. 渲染背景次级辅助波浪（增加景深与层次感）
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

    // 3. 渲染轻柔漂浮的微光粒子（不绘制生硬的几何图标，纯粹自然光尘）
    for (let i = 0; i < lightMotes.length; i++) {
      const m = lightMotes[i];
      m.x += m.vx;
      m.y += m.vy + Math.sin(time * m.speed + m.phase) * 0.25;

      if (m.x > width + 20) {
        m.x = -20;
        m.y = height * 0.3 + Math.random() * (height * 0.6);
      }
      if (m.y < -20) m.y = height + 20;
      else if (m.y > height + 20) m.y = -20;

      // 呼吸光晕
      const pulse = 0.5 + 0.5 * Math.sin(time * m.speed * 2 + m.phase);
      const alpha = (m.baseAlpha * (0.6 + 0.4 * pulse)).toFixed(3);

      ctx.beginPath();
      ctx.arc(m.x, m.y, m.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(9, 105, 218, ${alpha})`;
      ctx.fill();
    }

    // 4. 绘制点击产生的水波涟漪
    for (let i = ripples.length - 1; i >= 0; i--) {
      const r = ripples[i];
      r.r += 3.6;
      r.alpha *= 0.94;
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

  // ==========================================
  // 主循环
  // ==========================================
  function step(t: number) {
    if (!isRunning) return;
    animId = requestAnimationFrame(step);

    if (isEmulatorStarted()) {
      if (canvas) canvas.style.opacity = '0';
      return;
    }
    if (canvas) canvas.style.opacity = '1';

    if (Math.abs((canvas?.width || 0) / dpr - (idle?.clientWidth || 0)) > 2) {
      resize();
    }

    const theme = getCurrentTheme();
    if (theme === 'dark') {
      renderDark(t);
    } else {
      renderLight(t);
    }
  }

  // ==========================================
  // 事件监听
  // ==========================================
  const onPointerMove = (e: PointerEvent) => {
    if (!idle) return;
    const rect = idle.getBoundingClientRect();
    pointer.x = e.clientX - rect.left;
    pointer.y = e.clientY - rect.top;
    pointer.active = true;
  };

  const onPointerDown = (e: PointerEvent) => {
    if (!idle) return;
    const rect = idle.getBoundingClientRect();
    pointer.x = e.clientX - rect.left;
    pointer.y = e.clientY - rect.top;
    pointer.active = true;
    pointer.pressed = true;

    // 亮色模式添加水波涟漪
    if (getCurrentTheme() === 'light') {
      ripples.push({
        x: pointer.x,
        y: pointer.y,
        r: 8,
        maxR: 240,
        alpha: 0.36
      });
    }

    document.body.classList.add('psp-press');
    setTimeout(() => {
      pointer.pressed = false;
      document.body.classList.remove('psp-press');
    }, 450);
  };

  const onPointerLeave = () => {
    pointer.active = false;
    pointer.pressed = false;
  };

  const onWindowResize = () => {
    resize();
  };

  window.addEventListener('resize', onWindowResize, { passive: true });
  idle.addEventListener('pointermove', onPointerMove, { passive: true });
  idle.addEventListener('pointerdown', onPointerDown, { passive: true });
  idle.addEventListener('pointerleave', onPointerLeave, { passive: true });

  // 监听主题属性变更以即时刷新
  const themeObserver = new MutationObserver(() => {
    ripples.length = 0;
  });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  resize();
  animId = requestAnimationFrame(step);

  return () => {
    isRunning = false;
    cancelAnimationFrame(animId);
    window.removeEventListener('resize', onWindowResize);
    idle.removeEventListener('pointermove', onPointerMove);
    idle.removeEventListener('pointerdown', onPointerDown);
    idle.removeEventListener('pointerleave', onPointerLeave);
    themeObserver.disconnect();
    if (canvas && canvas.parentNode) {
      canvas.parentNode.removeChild(canvas);
    }
  };
}
