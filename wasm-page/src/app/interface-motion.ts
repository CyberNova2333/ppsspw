import { animate, createScope, stagger, utils } from "animejs";
import { mountIdleMotion } from "./idle-motion";

/** 只装饰待机面板。启动模拟器后停止并释放观察器，不触碰 canvas 或其祖先。 */
export function mountInterfaceMotion(): () => void {
  const idle = document.getElementById("idleOverlay");
  if (!idle || idle.hidden || idle.style.display === "none") {
    return () => {};
  }

  const stopIdleMotion = mountIdleMotion();

  const motion = createScope({
    root: idle,
    mediaQueries: { reduced: "(prefers-reduced-motion: reduce)" },
  }).add((self) => {
    if (!self || self.matches["reduced"]) return;
    const targets = Array.from(
      idle.querySelectorAll<HTMLElement>(
        ".idle-kicker,.idle-title,.idle-subtitle,.idle-actions,.idle-guide",
      ),
    );
    if (targets.length) {
      for (const el of targets) {
        el.style.opacity = "0";
        el.style.transform = "translateY(10px)";
      }
      animate(targets, {
        opacity: [0, 1],
        y: [10, 0],
        duration: 750,
        delay: stagger(80),
        ease: "outCubic",
        onComplete: utils.cleanInlineStyles,
      });
    }
  });
  const stop = () => {
    stopIdleMotion();
    observer.disconnect();
    motion.revert();
  };
  const observer = new MutationObserver(() => {
    if (idle.hidden || idle.style.display === "none") {
      stop();
    }
  });
  observer.observe(idle, {
    attributes: true,
    attributeFilter: ["style", "hidden"],
  });
  return stop;
}
