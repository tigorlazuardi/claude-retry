import { capturePane, inject } from './zellij.ts';
import type { MonitorDeps } from './monitor.ts';

export function buildDeps(): MonitorDeps {
  return {
    capture: (id: string) => capturePane(id),
    inject: (id: string, text: string) => inject(id, text),
    now: () => Date.now(),
    sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  };
}
