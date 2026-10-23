import { gzipSync } from 'node:zlib';

import type { Page, Response } from '@playwright/test';

/** A simulated connection, in the units the Chrome DevTools Protocol expects. */
export interface NetworkProfile {
  /** Extra round-trip time added to every request, in milliseconds. */
  latencyMs: number;
  downloadKbps: number;
  uploadKbps: number;
}

/**
 * 4G as Chrome DevTools calls "Fast 4G": 9 Mbps down, 1.5 Mbps up and 60 ms of latency
 * (RNF-01, RNF-03; plan §5.3).
 */
export const FOUR_G: NetworkProfile = {
  latencyMs: 60,
  downloadKbps: 9_000,
  uploadKbps: 1_500,
};

/** CPU slowdown that stands for a mid-range phone (plan §5.3: "CPU ×4"). */
export const CPU_SLOWDOWN = 4;

const BITS_PER_BYTE = 8;
const BITS_PER_KILOBIT = 1_000;

/** The Protocol takes bytes per second. */
const bytesPerSecond = (kbps: number): number => (kbps * BITS_PER_KILOBIT) / BITS_PER_BYTE;

/**
 * Throttles a Chromium page to `profile` and `cpuSlowdown`. The HTTP cache stays on, as for a
 * person who already used the app, unless `disableCache` makes every load a first visit. Only
 * Chromium exposes the DevTools Protocol, so call it there.
 */
export async function throttle(
  page: Page,
  options: { profile?: NetworkProfile; cpuSlowdown?: number; disableCache?: boolean } = {},
): Promise<void> {
  const { profile = FOUR_G, cpuSlowdown = CPU_SLOWDOWN, disableCache = false } = options;
  const session = await page.context().newCDPSession(page);
  await session.send('Network.enable');
  await session.send('Network.setCacheDisabled', { cacheDisabled: disableCache });
  await session.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: profile.latencyMs,
    downloadThroughput: bytesPerSecond(profile.downloadKbps),
    uploadThroughput: bytesPerSecond(profile.uploadKbps),
  });
  await session.send('Emulation.setCPUThrottlingRate', { rate: cpuSlowdown });
}

/** Size in bytes of `body` once gzipped at the maximum level, as a production server would send it. */
export function gzipSize(body: Buffer): number {
  return gzipSync(body, { level: 9 }).length;
}

const isScript = (response: Response): boolean => {
  const type = response.request().resourceType();
  if (type === 'script') return true;
  return /javascript/i.test(response.headers()['content-type'] ?? '');
};

/**
 * Starts adding up the JavaScript the page downloads (gzip bytes). Call `stop` after the load
 * settles to get the total and the files it is made of.
 */
export function collectScriptBytes(page: Page): {
  stop: () => Promise<{ total: number; files: Record<string, number> }>;
} {
  const pending: Promise<[string, number] | null>[] = [];
  const onResponse = (response: Response): void => {
    if (!response.ok() || !isScript(response)) return;
    pending.push(
      response
        .body()
        .then((body): [string, number] => [response.url(), gzipSize(body)])
        .catch(() => null),
    );
  };
  page.on('response', onResponse);
  return {
    stop: async () => {
      page.off('response', onResponse);
      const files: Record<string, number> = {};
      for (const entry of await Promise.all(pending)) {
        if (entry !== null) files[entry[0]] = entry[1];
      }
      const total = Object.values(files).reduce((sum, size) => sum + size, 0);
      return { total, files };
    },
  };
}
