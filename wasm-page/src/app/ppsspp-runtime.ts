import { DOCUMENT } from '@angular/common';
import { Injectable, inject } from '@angular/core';
import {
  Activity,
  Cloud,
  Download,
  Eye,
  ExternalLink,
  FileJson,
  FolderOpen,
  FolderPlus,
  Gamepad2,
  GitFork,
  HardDrive,
  Info,
  Link2,
  Maximize,
  Minimize,
  Monitor,
  PanelRight,
  Play,
  RadioTower,
  RefreshCw,
  Save,
  Server,
  Settings,
  Terminal,
  Trash2,
  Upload,
  X,
  createIcons,
} from 'lucide';

const PPSSPP_ICONS = {
  Activity,
  Cloud,
  Download,
  Eye,
  ExternalLink,
  FileJson,
  FolderOpen,
  FolderPlus,
  Gamepad2,
  GitFork,
  HardDrive,
  Info,
  Link2,
  Maximize,
  Minimize,
  Monitor,
  PanelRight,
  Play,
  RadioTower,
  RefreshCw,
  Save,
  Server,
  Settings,
  Terminal,
  Trash2,
  Upload,
  X,
};
const RUNTIME_ASSET_VERSION = 'ppsspp-player-v7';

@Injectable({ providedIn: 'root' })
export class PpssppRuntime {
  private readonly document = inject(DOCUMENT);
  private bootPromise?: Promise<void>;

  bootstrap(): Promise<void> {
    this.bootPromise ??= this.start();
    return this.bootPromise;
  }

  private async start(): Promise<void> {
    createIcons({ icons: PPSSPP_ICONS });
    await this.loadScript(`performance.js?v=${RUNTIME_ASSET_VERSION}`, 'performance');
    await this.loadScript(`browser-storage.js?v=${RUNTIME_ASSET_VERSION}`, 'browser-storage');
    await this.loadScript(`browser-files.js?v=${RUNTIME_ASSET_VERSION}`, 'browser-files');
    await this.loadScript(`adhoc-transport.js?v=${RUNTIME_ASSET_VERSION}`, 'adhoc-transport');
    await this.loadScript(`touch-controls.js?v=${RUNTIME_ASSET_VERSION}`, 'touch-controls');
    await this.loadScript(`ppsspp-runtime.js?v=${RUNTIME_ASSET_VERSION}`, 'ppsspp-runtime');
  }

  private loadScript(src: string, id: string): Promise<void> {
    const existing = this.document.querySelector<HTMLScriptElement>(`script[data-runtime-id="${id}"]`);
    if (existing) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const script = this.document.createElement('script');
      script.src = src;
      script.defer = true;
      script.dataset['runtimeId'] = id;
      script.addEventListener('load', () => resolve(), { once: true });
      script.addEventListener('error', () => reject(new Error(`页面组件加载失败：${src}。请检查连接后刷新重试。`)), { once: true });
      this.document.body.appendChild(script);
    });
  }
}
