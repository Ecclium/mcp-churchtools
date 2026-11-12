import { describe, expect, it } from 'vitest';

import {
  adoptionCheckOf,
  approvalKeyOf,
  contentHashOf,
  type PlanHashInput,
  planHashOf,
} from './plan-hash.js';

const content = contentHashOf(['Plan', '# Plan']);
const input: PlanHashInput = {
  tenantId: 'default',
  actorKind: 'service',
  actorId: 'stdio:local-stdio',
  tool: 'ct_wiki_page_create',
  intentKind: 'wikiPageCreate',
  targetKind: 'wiki_category',
  targetKey: '12',
  baseVersion: null,
  contentHash: content,
};

describe('the hash of a plan', () => {
  // Pinned, so that a change of the encoding is a decision, not an
  // accident: a confirmation or an approval names this hash. The values
  // were checked against a second implementation of the encoding.
  it('keeps its encoding', () => {
    expect(content).toBe(
      'e5de88ce5008d8057af9576df9e0b46b17f844d0edc00edac69c0580f8d976ba',
    );
    expect(planHashOf(input)).toBe(
      '86eeabb6bf44a7ab8b6987ce442f9a32480dad675f238072f31e9cb5d53516dd',
    );
    expect(contentHashOf([])).toBe(
      '10becbddb321de65cb468937aa4ba32b1d33c03efd96b4c4251ac1e320283165',
    );
  });

  it.each([
    ['tenant', { tenantId: 'other' }],
    ['kind of actor', { actorKind: 'user' }],
    ['ID of actor', { actorId: 'stdio:other' }],
    ['tool', { tool: 'ct_other' }],
    ['kind of intent', { intentKind: 'wikiPageUpdate' }],
    ['kind of target', { targetKind: 'wiki_page' }],
    ['key of target', { targetKey: '13' }],
    ['base version', { baseVersion: 0 }],
    ['content', { contentHash: contentHashOf(['Plan', '# Anders']) }],
  ] as const)('changes with the %s', (_name, change) => {
    expect(planHashOf({ ...input, ...change })).not.toBe(planHashOf(input));
  });

  it('tells no base version from version 0 and 1', () => {
    const hashes = new Set(
      [null, 0, 1].map((baseVersion) => planHashOf({ ...input, baseVersion })),
    );
    expect(hashes.size).toBe(3);
  });

  it('lets no value shift from one field into the next', () => {
    const a = planHashOf({ ...input, tenantId: 'ab', actorId: 'c' });
    const b = planHashOf({ ...input, tenantId: 'a', actorId: 'bc' });
    const c = planHashOf({ ...input, tenantId: 'a:', actorId: 'c' });
    expect(new Set([a, b, c]).size).toBe(3);
    expect(contentHashOf(['a', 'b'])).not.toBe(contentHashOf(['ab']));
    expect(contentHashOf(['a', '', 'b'])).not.toBe(contentHashOf(['a', 'b']));
    expect(contentHashOf([''])).not.toBe(contentHashOf([]));
    expect(contentHashOf(['1:a'])).not.toBe(contentHashOf(['1', 'a']));
  });

  it('counts the length of a field in bytes of UTF-8, not in code units', () => {
    // «é» is one code unit and two bytes; the value is the hash over the
    // tag, the count and «2:é», as the second implementation computed it.
    expect(contentHashOf(['é'])).toBe(
      '81c944e806d01a6c8308ddd157cfb3ceea490ec05915befe5b9a3981cd60b310',
    );
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses the base version %s',
    (baseVersion) => {
      expect(() => planHashOf({ ...input, baseVersion })).toThrow(TypeError);
    },
  );

  it('refuses a lone surrogate in any field, which UTF-8 could not tell apart', () => {
    expect(() => contentHashOf(['a\uD800'])).toThrow(TypeError);
    expect(() => planHashOf({ ...input, actorId: 'a\uDC00' })).toThrow(
      TypeError,
    );
  });
});

describe('the key of a decision about an entry of the queue (ADR 0029)', () => {
  const queueId = '11111111-2222-4333-8444-555555555555';
  const planHash = planHashOf(input);

  // Pinned like the hash of a plan, checked against a second
  // implementation of the encoding: a decision counted under one key must
  // be found under the same key after an update.
  it('keeps its encoding', () => {
    expect(approvalKeyOf(queueId, planHash)).toBe(
      'approval:9c5dbe3a5c31a6177266838f59ded58ac8e20fe79fb2a6e434f6d9accca9d18c',
    );
  });

  it('changes with the entry and with the plan', () => {
    const key = approvalKeyOf(queueId, planHash);
    expect(
      approvalKeyOf('11111111-2222-4333-8444-555555555556', planHash),
    ).not.toBe(key);
    expect(
      approvalKeyOf(queueId, planHashOf({ ...input, targetKey: '13' })),
    ).not.toBe(key);
  });

  it.each([
    ['an ID in capitals', 'AAAAAAAA-2222-4333-8444-555555555555', planHash],
    ['an ID of another form', 'entry-1', planHash],
    ['a hash too short', queueId, planHash.slice(1)],
    ['a hash in capitals', queueId, planHash.toUpperCase()],
  ])('refuses %s', (_name, id, hash) => {
    expect(() => approvalKeyOf(id, hash)).toThrow(TypeError);
  });
});

describe('adoptionCheckOf', () => {
  const input = {
    guid: '00000000-0000-4000-8000-0000000000c1',
    version: 4,
    section: '## KW 46\n\nText',
    line: 'Automatisch erstellt am 09.11.2026',
  };

  // Pinned, checked against a second implementation of the encoding: the
  // value a preview showed must still fit after an update.
  it('keeps its encoding and gives 16 hex digits', () => {
    expect(adoptionCheckOf(input)).toBe('ea49df4053e1c208');
  });

  it('changes with the page, its version, the section and the line', () => {
    const value = adoptionCheckOf(input);
    for (const other of [
      { guid: '00000000-0000-4000-8000-0000000000c2' },
      { version: 5 },
      { section: '## KW 46\n\nText.' },
      { line: 'Automatisch erstellt am 10.11.2026' },
      // A field may not run into the next one.
      {
        section: '## KW 46\n\nTextA',
        line: 'utomatisch erstellt am 09.11.2026',
      },
    ]) {
      expect(
        adoptionCheckOf({ ...input, ...other }),
        JSON.stringify(other),
      ).not.toBe(value);
    }
  });

  it('refuses a field with a lone surrogate', () => {
    expect(() => adoptionCheckOf({ ...input, section: '\ud800' })).toThrow(
      TypeError,
    );
  });
});
