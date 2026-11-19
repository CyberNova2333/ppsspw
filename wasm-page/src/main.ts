// SPDX-License-Identifier: GPL-2.0-or-later
// Derived from upstream root-hunter/ppsspp-web (GPL-2.0-or-later; see LICENSE.TXT and UPSTREAM.md), with modifications by CyberNova for PPSSPW (combined with PPSSPW AGPL-3.0-only modules under GPLv3/AGPLv3 Section 13).
import { provideZonelessChangeDetection } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';

import { AppComponent } from './app/app';

bootstrapApplication(AppComponent, {
  providers: [provideZonelessChangeDetection()],
}).catch((error) => console.error(error));
