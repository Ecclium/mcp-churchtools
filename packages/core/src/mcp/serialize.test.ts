import type { CallToolResult } from '@modelcontextprotocol/server';
import { describe, expect, expectTypeOf, it } from 'vitest';

import { fixedSentences } from '../errors/index.js';
import type { ToolOutcome } from '../pipeline/index.js';
import {
  maxResultBytes,
  resultBytes,
  resultReserveBytes,
} from '../pipeline/stages.js';
import { sealRedacted } from '../redaction/redacted.js';
import { serializeOutcome } from './serialize.js';

const encoder = new TextEncoder();
const bytes = (text: string): number => encoder.encode(text).byteLength;

const success = (data: Record<string, unknown>): ToolOutcome =>
  Object.freeze({ ok: true, data: sealRedacted(data) });

// Text that JSON escapes in every way it can. Invisible characters come
// from code points, so no tool rewrites them in this file.
const awkward = [
  '"quoted"',
  'line\nbreak',
  'back\\slash',
  'tab\there',
  'Grüezi',
  String.fromCodePoint(0x1f600),
  String.fromCodePoint(0xd800),
  String.fromCodePoint(0x2028, 0x2029),
  String.fromCodePoint(0x00, 0x1f, 0x7f),
  '<<data-a1b2c3d4e5f60718>>Text<</data-a1b2c3d4e5f60718>>',
].join(' ');

const samples: readonly Record<string, unknown>[] = [
  {},
  { text: '' },
  { text: awkward },
  { email: 'm***@example.org', notes: [awkward, null, 'b'] },
  { id: 1, ratio: -0.5, flag: false, nothing: null },
  { nested: { list: [[1, 2], { deep: awkward }] } },
];

// The text block of a result, which every result has exactly once.
const textOf = (result: CallToolResult): string => {
  expect(result.content).toHaveLength(1);
  const [block] = result.content;
  if (block?.type !== 'text') throw new Error('expected a text block');
  return block.text;
};

describe('serializeOutcome for a success', () => {
  it('writes the JSON of the data as text and the same value as structured content', () => {
    const outcome = success({ email: 'm***@example.org', id: 1 });
    if (!outcome.ok) throw new Error('expected a success');
    const result = serializeOutcome(outcome);
    expect(result).toEqual({
      content: [{ type: 'text', text: '{"email":"m***@example.org","id":1}' }],
      structuredContent: { email: 'm***@example.org', id: 1 },
    });
    expect(result.structuredContent).toBe(outcome.data);
    expect(Object.hasOwn(result, 'isError')).toBe(false);
  });

  it('writes the text exactly as JSON.stringify writes the data', () => {
    for (const data of samples) {
      const result = serializeOutcome(success(data));
      expect(textOf(result)).toBe(JSON.stringify(data));
      expect(result.structuredContent).toEqual(data);
    }
  });

  it('sends exactly the two copies that stage 9 of the pipeline counts', () => {
    // resultBytes is the count of the stage of the size: the JSON of the
    // data, that JSON as an escaped string, and the reserve. Both copies
    // of the result must be exactly these two, as the message sends them.
    for (const data of samples) {
      const result = serializeOutcome(success(data));
      const sent =
        bytes(JSON.stringify(result.structuredContent)) +
        bytes(JSON.stringify(textOf(result)));
      expect(sent + resultReserveBytes).toBe(resultBytes(data));
    }
  });

  it('leaves most of the reserve for the JSON-RPC message at the limit', () => {
    // Quotes cost the most on the wire. The longest text of quotes that
    // stage 9 still lets through.
    let count = Math.floor(maxResultBytes / 6);
    while (resultBytes({ text: '"'.repeat(count) }) > maxResultBytes) {
      count -= 1;
    }
    const data = { text: '"'.repeat(count) };
    expect(resultBytes(data)).toBeGreaterThan(maxResultBytes - 6);
    const result = serializeOutcome(success(data));
    const copies =
      bytes(JSON.stringify(result.structuredContent)) +
      bytes(JSON.stringify(textOf(result)));
    // The rest of the result is {"content":[{"type":"text","text":…}],
    // "structuredContent":…}, so 966 bytes of the reserve remain for the
    // envelope of the JSON-RPC message and _meta.
    expect(bytes(JSON.stringify(result)) - copies).toBe(58);
    expect(bytes(JSON.stringify(result))).toBeLessThanOrEqual(
      maxResultBytes - resultReserveBytes + 58,
    );
  });
});

describe('serializeOutcome for data without the mark of a redacted result', () => {
  const internal = {
    content: [{ type: 'text', text: fixedSentences.internal }],
    isError: true,
  };

  it.each([
    ['plain data', { email: 'max.mustermann@example.org' }],
    ['a copy of marked data', { ...sealRedacted({ id: 1 }) }],
    [
      'a proxy that reports every property',
      new Proxy(
        {},
        {
          getOwnPropertyDescriptor: () => ({
            value: true,
            writable: false,
            enumerable: false,
            configurable: false,
          }),
        },
      ),
    ],
  ])('sends the fixed sentence of internal instead of %s', (_name, data) => {
    // A cast, as code compiled on its own could make, gets past the types
    // but not past the check at run time (ADR 0026).
    const forged = { ok: true, data } as unknown as ToolOutcome;
    expect(serializeOutcome(forged)).toEqual(internal);
  });
});

describe('serializeOutcome for a failure', () => {
  it('writes the sentence as text with isError and no structured content', () => {
    const result = serializeOutcome({
      ok: false,
      error: { code: 'validation', message: fixedSentences.validation },
    });
    expect(result).toEqual({
      content: [{ type: 'text', text: fixedSentences.validation }],
      isError: true,
    });
    expect(Object.hasOwn(result, 'structuredContent')).toBe(false);
  });

  it('names each missing right on a line of its own', () => {
    const result = serializeOutcome({
      ok: false,
      error: {
        code: 'permission',
        message: fixedSentences.permission,
        missingRights: [
          { module: 'churchdb', right: 'view alldata' },
          { module: 'churchgroup', right: 'view groups of grouptype' },
          { module: 'churchwiki', right: 'view, edit; all' },
        ],
      },
    });
    expect(textOf(result)).toBe(
      [
        fixedSentences.permission,
        'Missing rights:',
        '- churchdb: view alldata',
        '- churchgroup: view groups of grouptype',
        '- churchwiki: view, edit; all',
      ].join('\n'),
    );
    expect(result.isError).toBe(true);
  });

  it('leaves out an empty list of rights and the code', () => {
    const result = serializeOutcome({
      ok: false,
      error: {
        code: 'permission',
        message: fixedSentences.permission,
        missingRights: [],
      },
    });
    expect(textOf(result)).toBe(fixedSentences.permission);
  });
});

describe('serializeOutcome', () => {
  it('freezes the result, its list of blocks and the block', () => {
    const results = [
      serializeOutcome(success({ text: 'x' })),
      serializeOutcome({
        ok: false,
        error: { code: 'internal', message: fixedSentences.internal },
      }),
    ];
    for (const result of results) {
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.content)).toBe(true);
      expect(Object.isFrozen(result.content[0])).toBe(true);
    }
  });

  it('returns the result type of MCP', () => {
    expectTypeOf(serializeOutcome).returns.toEqualTypeOf<CallToolResult>();
  });
});
