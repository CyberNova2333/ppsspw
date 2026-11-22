// SPDX-License-Identifier: GPL-2.0-or-later
// Derived from upstream root-hunter/ppsspp-web (GPL-2.0-or-later; see LICENSE.TXT and UPSTREAM.md), with modifications by CyberNova for PPSSPW (combined with PPSSPW AGPL-3.0-only modules under GPLv3/AGPLv3 Section 13).
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
      const compactSetting = document.getElementById('compactThemeSetting');
      if (container && compactSetting) {
        const compact = matchMedia('(max-width: 700px), (pointer: coarse) and (max-height: 560px), (pointer: coarse) and (max-width: 920px)');
        const toolbar = container.parentElement!;
        const menu = document.getElementById('panelToggleBtn');
        const placeSwitch = () => {
          compactSetting.hidden = !compact.matches;
          if (compact.matches) compactSetting.append(container);
          else toolbar.insertBefore(container, menu);
        };
        placeSwitch();
        compact.addEventListener('change', placeSwitch);
        this.destroyRef.onDestroy(() => compact.removeEventListener('change', placeSwitch));
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
