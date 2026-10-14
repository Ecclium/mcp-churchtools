import type { Mode, RedactionLevel } from '@ecclium/mcp-churchtools-plugin-api';
import { makeCanaries } from '@ecclium/mcp-churchtools-testkit';
import { describe, expect, it } from 'vitest';

import {
  hostPattern,
  isBoolean,
  isErrorCode,
  isEventName,
  isIntegerIn,
  isMode,
  isRedactionLevel,
  isTenantId,
  isToolName,
  isUuid,
  modes,
  redactionLevels,
  tenantIdPattern,
  timestampPattern,
  toolNamePattern,
  toTimestamp,
  uuidPattern,
} from './index.js';

// Lists every value once. A value missing here fails the type check, a
// value missing from the frozen list fails the comparison below.
const everyMode: Readonly<Record<Mode, true>> = {
  interactive: true,
  unattended: true,
  operator: true,
};
const everyRedactionLevel: Readonly<Record<RedactionLevel, true>> = {
  off: true,
  standard: true,
  strict: true,
};

describe('modes and redactionLevels', () => {
  it('list every value once and are frozen', () => {
    expect([...modes].sort()).toEqual(Object.keys(everyMode).sort());
    expect([...redactionLevels].sort()).toEqual(
      Object.keys(everyRedactionLevel).sort(),
    );
    expect(Object.isFrozen(modes)).toBe(true);
    expect(Object.isFrozen(redactionLevels)).toBe(true);
  });
});

// Strings that look right but are not: other scripts, lookalikes that a
// pattern with the flag i or u would let through, line breaks and lone
// surrogates, which JSON.stringify writes as an escape and would hide.
const lookalikes = [
  '\u017f',
  '\u212a',
  '\uff41',
  'a\n',
  '\na',
  'a\r',
  'a\u2028',
  'ok\ud800',
  '\udfff',
  'a\ud83d',
  'a ',
  ' a',
  'a\u0000',
] as const;

describe('isEventName', () => {
  it.each(['a', 'cache_skipped', 'a1', `a${'b'.repeat(63)}`])(
    'accepts %s',
    (name) => {
      expect(isEventName(name)).toBe(true);
    },
  );

  it.each([
    '',
    '1a',
    '_a',
    'A',
    'Cache',
    'a-b',
    'a.b',
    `a${'b'.repeat(64)}`,
    ...lookalikes,
  ])('refuses %j', (name) => {
    expect(isEventName(name)).toBe(false);
  });

  it('refuses a value that is no string without coercing it', () => {
    let calls = 0;
    const hostile = {
      toString: () => {
        calls += 1;
        return 'cache_skipped';
      },
    };
    for (const value of [hostile, ['a'], 1, null, undefined, Symbol('a')]) {
      expect(isEventName(value)).toBe(false);
    }
    expect(calls).toBe(0);
  });

  it('refuses a huge string at once', () => {
    const started = performance.now();
    expect(isEventName(`a${'b'.repeat(10_000_000)}`)).toBe(false);
    expect(performance.now() - started).toBeLessThan(50);
  });

  it('gives the same answer every time, so no pattern keeps a lastIndex', () => {
    const values = {
      event: 'cache_skipped',
      tenant: 'demo-tenant',
      tool: 'ct_group_search',
      uuid: '0b0e9a3c-3f7e-4c62-9a55-6a1f0d2c7e11',
    };
    for (let round = 0; round < 3; round += 1) {
      expect(isEventName(values.event)).toBe(true);
      expect(isTenantId(values.tenant)).toBe(true);
      expect(isToolName(values.tool)).toBe(true);
      expect(isUuid(values.uuid)).toBe(true);
    }
  });
});

describe('isTenantId', () => {
  it.each(['demo-tenant', 'a', '0', `a${'b'.repeat(62)}`, 'a-'])(
    'accepts %s',
    (id) => {
      expect(isTenantId(id)).toBe(true);
    },
  );

  it.each([
    '',
    '-a',
    'Demo',
    'demo_tenant',
    `a${'b'.repeat(63)}`,
    ...lookalikes,
  ])('refuses %j', (id) => {
    expect(isTenantId(id)).toBe(false);
  });
});

describe('isToolName', () => {
  it.each(['ct_a', 'ct_group_search', `ct_${'a'.repeat(60)}`])(
    'accepts %s',
    (name) => {
      expect(isToolName(name)).toBe(true);
    },
  );

  it.each([
    'ct_',
    'ct_getPerson',
    'ct-group',
    'group_search',
    `ct_${'a'.repeat(61)}`,
    'ct_a\n',
  ])('refuses %j', (name) => {
    expect(isToolName(name)).toBe(false);
  });
});

describe('isUuid', () => {
  it('accepts a UUID in lower case', () => {
    expect(isUuid('0b0e9a3c-3f7e-4c62-9a55-6a1f0d2c7e11')).toBe(true);
  });

  it.each([
    '0B0E9A3C-3F7E-4C62-9A55-6A1F0D2C7E11',
    '0b0e9a3c-3f7e-4c62-9a55-6a1f0d2c7e11\n',
    '0b0e9a3c3f7e4c629a556a1f0d2c7e11',
    '{0b0e9a3c-3f7e-4c62-9a55-6a1f0d2c7e11}',
    '0b0e9a3c-3f7e-4c62-9a55-6a1f0d2c7e1g',
  ])('refuses %j', (id) => {
    expect(isUuid(id)).toBe(false);
  });
});

describe('the checks of enumerations', () => {
  it('compare exactly, without case folding or normalising', () => {
    expect(isErrorCode('internal')).toBe(true);
    expect(isMode('operator')).toBe(true);
    expect(isRedactionLevel('standard')).toBe(true);
    for (const value of [
      'INTERNAL',
      '\u0130nternal',
      '\uff49\uff4e\uff54\uff45\uff52\uff4e\uff41\uff4c',
      'constructor',
      'toString',
      '__proto__',
      '',
    ]) {
      expect(isErrorCode(value), value).toBe(false);
      expect(isMode(value), value).toBe(false);
      expect(isRedactionLevel(value), value).toBe(false);
    }
  });
});

describe('isBoolean', () => {
  it('accepts only real booleans', () => {
    expect(isBoolean(false)).toBe(true);
    expect(isBoolean(true)).toBe(true);
    for (const value of ['false', 0, 1, null, undefined, {}]) {
      expect(isBoolean(value)).toBe(false);
    }
  });
});

describe('isIntegerIn', () => {
  it('accepts whole numbers in the range, also -0 and the bounds', () => {
    const check = isIntegerIn(0, 10);
    for (const value of [0, -0, 10, 5]) expect(check(value)).toBe(true);
  });

  it('refuses everything else without coercing', () => {
    const check = isIntegerIn(0, 10);
    for (const value of [
      -1,
      11,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      '5',
      true,
      5n,
      null,
      [5],
    ]) {
      expect(check(value)).toBe(false);
    }
  });
});

describe('canary values', () => {
  it('break every pattern, so a test that finds none in a line proves something', () => {
    for (const canary of makeCanaries().all) {
      for (const check of [isEventName, isTenantId, isToolName, isUuid]) {
        expect(check(canary.value), canary.kind).toBe(false);
      }
    }
  });
});

describe('the exported patterns', () => {
  it('have no flags, so that a schema that uses them keeps no state', () => {
    for (const pattern of [
      hostPattern,
      tenantIdPattern,
      toolNamePattern,
      uuidPattern,
      timestampPattern,
    ]) {
      expect(pattern.flags).toBe('');
    }
  });
});

describe('toTimestamp', () => {
  it.each([
    [1_760_000_000_123, '2025-10-09T08:53:20.123Z'],
    [1_760_000_000_123.9, '2025-10-09T08:53:20.123Z'],
    [-1, '1969-12-31T23:59:59.999Z'],
    [0, '1970-01-01T00:00:00.000Z'],
    [253_402_300_799_999, '9999-12-31T23:59:59.999Z'],
  ])('turns %j into %s', (now, expected) => {
    expect(toTimestamp(now)).toBe(expected);
  });

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    253_402_300_800_000,
    8.64e15,
    8.64e15 + 1,
    -62_198_755_200_001,
    1_760_000_000_123n,
    '5',
    null,
    undefined,
    [5],
  ])('refuses %s', (now) => {
    expect(toTimestamp(now)).toBeUndefined();
  });
});
