// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of PPSSPW and is licensed under GNU AGPLv3 with Additional Terms (see LICENSE and LICENSE-ADDITIONAL_TERMS-zh-CN.md; ref: LICENSE-ADDITIONAL_TERMS-en.md).
import { afterNextRender, ChangeDetectionStrategy, Component, DestroyRef, inject } from '@angular/core';

import { PpssppRuntime } from './ppsspp-runtime';
import { mountInterfaceMotion } from './interface-motion';

@Component({
  selector: 'app-root',
  templateUrl: './app.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppComponent {
  private readonly runtime = inject(PpssppRuntime);
  private readonly destroyRef = inject(DestroyRef);

  constructor() {
    afterNextRender(() => {
      this.destroyRef.onDestroy(mountInterfaceMotion());

      const container = document.getElementById('ppsspw-theme-switch');
      if (container) {
        const dns = (window as unknown as { DayNightSwitch?: { mount: (el: HTMLElement, opts: unknown) => () => void } }).DayNightSwitch;
        if (dns) {
          const unmount = dns.mount(container, {
            isDark: () => document.documentElement.dataset['theme'] === 'dark',
            onToggle: (dark: boolean) => {
              document.documentElement.dataset['theme'] = dark ? 'dark' : 'light';
            }
          });
          if (unmount) this.destroyRef.onDestroy(unmount);
        }
      }

      void this.runtime.bootstrap().catch((error: unknown) => {
        console.error(error);
        const recovery = document.getElementById('runtimeRecovery');
        const message = document.getElementById('runtimeFailureMessage');
        if (message) message.textContent = error instanceof Error ? error.message : '页面加载失败，请刷新重试。';
        if (recovery) recovery.hidden = false;
        for (const id of ['startBtn', 'idleStartBtn', 'recoverySettingsBtn', 'recoveryReportBtn']) {
          const button = document.getElementById(id) as HTMLButtonElement | null;
          if (button) button.disabled = true;
        }
        document.getElementById('recoveryReloadBtn')?.addEventListener('click', () => location.reload());
      });
    });
  }
}
