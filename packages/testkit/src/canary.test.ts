import { inspect } from 'node:util';

import { describe, expect, it } from 'vitest';

import {
  assertNoCanary,
  assertPlanted,
  findCanaries,
  makeCanaries,
  makeCanary,
  makeControlValue,
} from './index.js';

// The detector is itself a check: each test plants a canary in a known form
// and expects it to be found, and noise without canaries must stay clean.

const visibleAscii = /^[\x21-\x7E]+$/;

describe('canary values', () => {
  it('give a token of visible ASCII characters that JSON must escape', () => {
    const token = makeCanary('token');
    expect(token.value).toMatch(visibleAscii);
    expect(token.value.length).toBeGreaterThan(64);
    expect(JSON.stringify(token.value).slice(1, -1)).not.toBe(token.value);
    for (const core of token.cores) expect(token.value).toContain(core);
  });

  it('give an e-mail address at example.org only', () => {
    const email = makeCanary('email');
    expect(email.value).toMatch(
      /^[a-z0-9]{10}\.[a-z0-9]{10}\+[a-z0-9]{4}@example\.org$/,
    );
  });

  it('give a name with an umlaut whose case maps one to one', () => {
    const name = makeCanary('name');
    expect(name.value).toMatch(/^[A-Z][a-z]{11} [A-Z][a-z]{10}[äöüé]$/u);
    expect(name.value.toUpperCase()).toHaveLength(name.value.length);
  });

  it('give a phone number no real number matches', () => {
    expect(makeCanary('phone').value).toMatch(
      /^\+41 0\d{2} \d{3} \d{2} \d{2} \d{3}$/,
    );
  });

  it('are fresh each time', () => {
    const first = makeCanaries();
    const second = makeCanaries();
    for (const [index, canary] of first.all.entries()) {
      expect(canary.value).not.toBe(second.all[index]?.value);
    }
  });

  it('give a control value that passes the pattern of a tenant ID', () => {
    expect(makeControlValue()).toMatch(/^[a-z0-9][a-z0-9-]{0,62}$/);
  });
});

describe('findCanaries', () => {
  const canaries = makeCanaries();
  const { token, email, name, phone } = canaries;

  it.each([
    ['as is', (v: string) => v],
    ['in capitals', (v: string) => v.toUpperCase()],
    ['in small letters', (v: string) => v.toLowerCase()],
    ['as JSON', (v: string) => JSON.stringify({ field: v })],
    ['as a URL component', (v: string) => encodeURIComponent(v)],
    ['as hex', (v: string) => Buffer.from(v).toString('hex')],
    ['split over lines', (v: string) => `${v.slice(0, 20)}\n   ${v.slice(20)}`],
    [
      'as util.inspect splits it into short lines',
      (v: string) => inspect((v.match(/.{1,6}/gsu) ?? []).join('\n')),
    ],
  ])('find each kind %s', (_how, encode) => {
    for (const canary of canaries.all) {
      const found = findCanaries(`before ${encode(canary.value)} after`, [
        canary,
      ]);
      expect(found.length, canary.kind).toBeGreaterThan(0);
    }
  });

  it('find a value broken into lines shorter than any piece that counts', () => {
    for (const canary of [token, email, name]) {
      const broken = (canary.value.match(/.{1,6}/gsu) ?? []).join('\n  ');
      const found = findCanaries(broken, [canary]);
      expect(found.length, canary.kind).toBeGreaterThan(0);
      expect(
        found.every((f) => f.squeezed),
        canary.kind,
      ).toBe(true);
    }
  });

  it.each([
    ['a literal \\n', '\\n'],
    ['a literal \\r', '\\r'],
    ['a literal \\t', '\\t'],
    ['the join of util.inspect', "' +\n  '"],
    ['a join without spaces', "'+'"],
  ])(
    'find a value broken by %s into pieces shorter than any that counts',
    (_what, separator) => {
      for (const canary of [token, email, name]) {
        const broken = (canary.value.match(/.{1,6}/gsu) ?? []).join(separator);
        const found = findCanaries(broken, [canary]);
        expect(found.length, canary.kind).toBeGreaterThan(0);
        expect(
          found.every((f) => f.squeezed),
          canary.kind,
        ).toBe(true);
      }
    },
  );

  it.each([0, 1, 2])('find base64 after %i bytes of anything', (shift) => {
    for (const canary of canaries.all) {
      const encoded = Buffer.from(
        `${'x'.repeat(shift)}${canary.value}!`,
      ).toString('base64');
      expect(
        findCanaries(encoded, [canary]).length,
        canary.kind,
      ).toBeGreaterThan(0);
    }
  });

  it('find base64 of a value that JSON escaped first', () => {
    const encoded = Buffer.from(JSON.stringify({ x: token.value })).toString(
      'base64',
    );
    expect(findCanaries(encoded, [token]).map((f) => f.form)).toContain(
      'base64',
    );
  });

  it('find a piece of a core of the minimum length, not one shorter', () => {
    for (const canary of [token, email, name]) {
      const core = canary.cores[0] ?? '';
      const piece = core.slice(0, canary.minFragment);
      expect(
        findCanaries(`~~~~${piece}~~~~`, [canary]).length,
        canary.kind,
      ).toBeGreaterThan(0);
      expect(
        findCanaries(`~~~~${piece.slice(1)}~~~~`, [canary]),
        canary.kind,
      ).toEqual([]);
    }
  });

  it('find a phone number by its digits whatever separates them', () => {
    const core = phone.cores[0] ?? '';
    const written = core.replaceAll(/(\d{3})/g, '$1-');
    expect(findCanaries(written, [phone]).map((f) => f.form)).toContain(
      'digits',
    );
  });

  it('find canaries inside objects the defaults of inspect would cut', () => {
    let deep: unknown = { leaf: email.value };
    for (let level = 0; level < 2000; level += 1) deep = { next: deep };
    const hidden = {};
    Object.defineProperty(hidden, 'secret', {
      value: name.value,
      enumerable: false,
    });
    const cases: [string, unknown][] = [
      ['a deep object', deep],
      ['bytes in an object', { body: new TextEncoder().encode(token.value) }],
      ['a map', new Map([['k', token.value]])],
      ['a set', new Set([email.value])],
      ['a symbol key', { [Symbol('s')]: name.value }],
      ['a hidden property', hidden],
      [
        'the cause of an error',
        new Error('fine', { cause: new Error(token.value) }),
      ],
      [
        'a long array',
        Array.from({ length: 500 }, (_v, i) => (i === 499 ? email.value : 'x')),
      ],
    ];
    for (const [what, haystack] of cases) {
      expect(findCanaries(haystack, canaries.all).length, what).toBeGreaterThan(
        0,
      );
    }
  });

  it('never throws, also on a proxy whose traps throw', () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error(token.value);
        },
        getOwnPropertyDescriptor: () => {
          throw new Error(token.value);
        },
      },
    );
    expect(() => findCanaries(hostile, canaries.all)).not.toThrow();
  });

  it('report nothing for noise without canaries', () => {
    for (let round = 0; round < 200; round += 1) {
      const fresh = makeCanaries();
      const noise = [
        makeControlValue(),
        'CANARY',
        '@example.org',
        'max.mustermann@example.org',
        '+41 0',
        Buffer.from(makeCanary('token').value).toString('base64'),
        JSON.stringify({
          level: 'info',
          event: 'tool_call_done',
          count: round,
        }),
      ].join(' ');
      expect(findCanaries(noise, fresh.all)).toEqual([]);
    }
  });

  it('match the characters of a token literally', () => {
    const lookalike = token.value.replaceAll(/[()[\]{}$]/g, '.');
    expect(() => findCanaries(lookalike, [token])).not.toThrow();
    expect(findCanaries(lookalike, [token]).map((f) => f.part)).not.toContain(
      'value',
    );
  });
});

describe('assertNoCanary and assertPlanted', () => {
  const canaries = makeCanaries();

  it('fail without showing a value', () => {
    let message = '';
    try {
      assertNoCanary(`x ${canaries.token.value} y`, canaries.all, 'probe');
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('probe');
    expect(message).toContain('token');
    expect(findCanaries(message, canaries.all)).toEqual([]);
  });

  it('pass a clean haystack', () => {
    expect(() => {
      assertNoCanary('{"level":"info","event":"probe"}', canaries.all, 'probe');
    }).not.toThrow();
  });

  it('require the whole value for a plant', () => {
    const { token } = canaries;
    expect(() => {
      assertPlanted({ field: token.value }, [token], 'fields');
    }).not.toThrow();
    expect(() => {
      assertPlanted(JSON.stringify(token.value), [token], 'escaped');
    }).toThrow('escaped lacks the planted canaries: token');
    expect(() => {
      assertPlanted(token.cores[0], [token], 'core only');
    }).toThrow('core only');
  });
});
