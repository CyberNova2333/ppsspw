import { animate, createScope, stagger, utils } from 'animejs';

/** 只装饰待机面板。启动模拟器后停止并释放观察器，不触碰 canvas 或其祖先。 */
export function mountInterfaceMotion(): () => void {
  const idle = document.getElementById('idleOverlay');
  if (!idle || idle.hidden || idle.style.display === 'none') return () => {};
  const motion = createScope({ root: idle, mediaQueries: { reduced: '(prefers-reduced-motion: reduce)' } }).add((self) => {
    if (!self || self.matches['reduced']) return;
    const targets = idle.querySelectorAll('.idle-kicker,.idle-title,.idle-subtitle,.idle-actions,.idle-guide');
    if (targets.length) animate(targets, {
      opacity: [0, 1], y: [12, 0], duration: 300, delay: stagger(50),
      ease: 'outQuart', onComplete: utils.cleanInlineStyles,
    });
  });
  const stop = () => { observer.disconnect(); motion.revert(); };
  const observer = new MutationObserver(() => {
    if (idle.hidden || idle.style.display === 'none') stop();
  });
  observer.observe(idle, { attributes: true, attributeFilter: ['style', 'hidden'] });
  return stop;
}
