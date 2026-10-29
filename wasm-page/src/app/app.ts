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
