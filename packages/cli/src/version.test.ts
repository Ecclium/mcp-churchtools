import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { userAgent, version } from './version.js';

// The constants stand in for a read of package.json at run time. When the
// version of the package changes, they must change with it.
const manifest = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { readonly version?: unknown };

/** Whether every character lies between the two codes. */
const within = (text: string, low: number, high: number): boolean => {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < low || code > high) return false;
  }
  return true;
};

describe('the version of the command line', () => {
  it('is the version of the package', () => {
    expect(typeof manifest.version).toBe('string');
    expect(version).toBe(manifest.version);
  });

  it('names Ecclium and the version of the package in the User-Agent', () => {
    expect(userAgent).toBe(`Ecclium/${String(manifest.version)}`);
  });

  // The mount refuses a version for serverInfo outside 1 to 32 printable
  // ASCII characters without spaces, and the transport a User-Agent
  // outside 1 to 256 printable ASCII characters or with a blank at either
  // end. Both checks run at the start, so a version that broke them would
  // stop every start.
  it('fits the forms of serverInfo and of the User-Agent', () => {
    expect(version.length).toBeGreaterThanOrEqual(1);
    expect(version.length).toBeLessThanOrEqual(32);
    expect(within(version, 0x21, 0x7e)).toBe(true);
    expect(userAgent.length).toBeGreaterThanOrEqual(1);
    expect(userAgent.length).toBeLessThanOrEqual(256);
    expect(within(userAgent, 0x20, 0x7e)).toBe(true);
    expect(userAgent.trim()).toBe(userAgent);
  });
});
