import { describe, expect, it } from 'vitest';

import type { LineWriter } from '../logger/index.js';
import { createDefaultTenantLogger } from './default-logger.js';

const frozenClock = Object.freeze({ now: Object.freeze(() => 0) });

const recording = (lines: string[]): LineWriter =>
  Object.freeze({
    write: (line: string): boolean => {
      lines.push(line);
      return true;
    },
  });

describe('createDefaultTenantLogger', () => {
  it('binds every line to the tenant default, which a call cannot change', () => {
    const lines: string[] = [];
    const logger = createDefaultTenantLogger({
      writer: recording(lines),
      clock: frozenClock,
      minLevel: 'info',
    });
    logger.debug('http_below_level');
    logger.info('http_response', { status: 200, durationMs: 3 });
    logger.warn('http_refused', { code: 'internal', tenantId: 'demo-tenant' });
    expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([
      {
        ts: '1970-01-01T00:00:00.000Z',
        level: 'info',
        event: 'http_response',
        tenantId: 'default',
        status: 200,
        durationMs: 3,
      },
      {
        ts: '1970-01-01T00:00:00.000Z',
        level: 'warn',
        event: 'http_refused',
        tenantId: 'default',
        code: 'internal',
        dropped: 1,
      },
    ]);
    expect(Object.isFrozen(logger)).toBe(true);
  });

  it('refuses what the logger refuses, with its fixed message', () => {
    expect(() =>
      createDefaultTenantLogger({
        writer: undefined as unknown as LineWriter,
        clock: frozenClock,
        minLevel: 'info',
      }),
    ).toThrow(new TypeError('The logger needs a writer, a clock and a level.'));
  });
});
