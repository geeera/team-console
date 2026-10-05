import '@angular/compiler';
import { webcrypto } from 'node:crypto';
import '@analogjs/vitest-angular/setup-snapshots';
import { setupTestBed } from '@analogjs/vitest-angular/setup-testbed';

setupTestBed();

// jsdom's crypto has no `subtle`; the browser's SHA-256 (device ids) comes from Node's WebCrypto here.
if (globalThis.crypto?.subtle === undefined) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
}
