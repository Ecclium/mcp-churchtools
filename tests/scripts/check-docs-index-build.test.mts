import { describe, expect, it } from 'vitest';

import {
  compareBuilds,
  secondBuildEnvironment,
  sha256,
} from '../../scripts/ci/check-docs-index-build.mts';

// The comparison of two builds of the docs index (ADR 0066). The script
// itself runs in pnpm ci:check after pnpm build; here only its verdict.

const bytes = (text: string) => new TextEncoder().encode(text);

describe('compareBuilds', () => {
  it('accepts two equal builds and names their hash', () => {
    const { same, line } = compareBuilds(bytes('{"a":1}'), bytes('{"a":1}'));
    expect(same).toBe(true);
    expect(line).toBe(
      `Doku-Index zweimal gebaut, gleicher SHA-256 ${sha256(bytes('{"a":1}'))}.`,
    );
  });

  it('refuses two builds that differ in one byte, with both hashes', () => {
    const { same, line } = compareBuilds(bytes('{"a":1}'), bytes('{"a":2}'));
    expect(same).toBe(false);
    expect(line).toContain(sha256(bytes('{"a":1}')));
    expect(line).toContain(sha256(bytes('{"a":2}')));
    expect(line).not.toContain('"a"');
  });

  it('runs the second build away from UTC and in another language', () => {
    expect(secondBuildEnvironment.TZ).not.toMatch(/UTC|Zurich|Berlin/);
    expect(secondBuildEnvironment.LC_ALL).not.toMatch(/^(C|de|en)/);
  });
});
