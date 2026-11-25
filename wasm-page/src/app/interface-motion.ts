// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of PPSSPW and is licensed under GNU AGPLv3 with Additional Terms (see LICENSE and LICENSE-ADDITIONAL_TERMS-zh-CN.md; ref: LICENSE-ADDITIONAL_TERMS-en.md).
import { animate, createScope, stagger } from "animejs";
import { mountIdleMotion } from "./idle-motion";

/** 只装饰待机面板。启动模拟器时休眠并中止入场动画，若启动中断或回到待机层可自动恢复。 */
export function mountInterfaceMotion(): () => void {
  const idle = document.getElementById("idleOverlay");
  if (!idle) {
    return () => {};
  }

  const stopIdleMotion = mountIdleMotion();
  const started =
    document.body.classList.contains("emulator-started") ||
    idle.hidden ||
    idle.style.display === "none";

  const targets = Array.from(
    idle.querySelectorAll<HTMLElement>(
      ".idle-kicker,.idle-title,.idle-subtitle,.idle-actions,.idle-guide",
    ),
  );

  const clearTargetStyles = () => {
    for (const el of targets) {
      el.style.removeProperty("opacity");
      el.style.removeProperty("transform");
    }
  };

  const motion = createScope({
    root: idle,
    mediaQueries: { reduced: "(prefers-reduced-motion: reduce)" },
  }).add((self) => {
    if (!self || self.matches["reduced"] || started || !targets.length) return;
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
      onComplete: clearTargetStyles,
    });
  });

  const stopEntrance = () => {
    motion.revert();
    clearTargetStyles();
    idleObserver.disconnect();
    bodyObserver.disconnect();
  };

  const checkHidden = () => {
    if (
      document.body.classList.contains("emulator-started") ||
      idle.hidden ||
      idle.style.display === "none"
    ) {
      stopEntrance();
    }
  };

  const idleObserver = new MutationObserver(checkHidden);
  idleObserver.observe(idle, { attributes: true, attributeFilter: ["style", "hidden"] });

  const bodyObserver = new MutationObserver(checkHidden);
  bodyObserver.observe(document.body, { attributes: true, attributeFilter: ["class"] });

  return () => {
    stopEntrance();
    stopIdleMotion();
  };
}
