import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { canonicalMarkdown, checkMarkdown } from './check.js';
import { readMarkdown } from './lexer.js';
import { serializeBlocks } from './serialize.js';
import type { Inline } from './tree.js';

// Generated texts (ADR 0030, ADR 0070): the serializer and the checks hold
// for every one, not only for the examples of the other tests. A fixed
// seed keeps the runs the same in CI.

const seed = 30_007;
const run = { seed, numRuns: 400 };

const options = { contacts: new Set<string>() };

// Letters, digits, spaces and every sign of ASCII that Markdown knows,
// with a line break now and then: the signs the escaping must handle.
const signs = [
  ...Array.from('aZäß09 '),
  ...Array.from('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'),
  '\n',
];
const raw = fc.string({ unit: fc.constantFrom(...signs), maxLength: 60 });

// A text as the lexer gives it: no spaces around a line break, no empty
// line, nothing at its edges.
const tidy = (value: string): string =>
  value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join('\n')
    .trim();

const text = raw.map(tidy).filter((value) => value !== '');

const word = fc.stringMatching(/^[a-zäöüA-Z]{1,8}$/u);
const words = fc
  .array(word, { minLength: 1, maxLength: 5 })
  .map((parts) => parts.join(' '));

// A small document of Markdown in many forms, valid or not.
const inline = fc.oneof(
  words,
  words.map((value) => `**${value}**`),
  words.map((value) => `*${value}*`),
  words.map((value) => `_${value}_`),
  raw,
);
const line = fc
  .array(inline, { minLength: 1, maxLength: 4 })
  .map((parts) => parts.join(' '));
const block = fc.oneof(
  line,
  fc
    .tuple(fc.integer({ min: 1, max: 6 }), line)
    .map(([level, value]) => `${'#'.repeat(level)} ${value}`),
  fc
    .tuple(
      fc.constantFrom('- ', '* ', '+ ', '1. ', '3) '),
      fc.array(line, { minLength: 1, maxLength: 4 }),
    )
    .map(([marker, items]) => items.map((item) => marker + item).join('\n')),
  fc.array(line, { minLength: 1, maxLength: 3 }).map(
    (items) =>
      `- ${items[0] ?? ''}\n${items
        .slice(1)
        .map((item) => `  - ${item}`)
        .join('\n')}`,
  ),
  fc
    .tuple(
      fc.array(words, { minLength: 1, maxLength: 3 }),
      fc.array(words, { maxLength: 3 }),
    )
    .map(([header, cells]) => {
      const row = (values: readonly string[]): string =>
        `| ${header.map((_, index) => values[index] ?? '').join(' | ')} |`;
      return [row(header), row(header.map(() => '---')), row(cells)].join('\n');
    }),
);
const document = fc
  .array(block, { minLength: 1, maxLength: 5 })
  .chain((blocks) =>
    fc
      .array(fc.constantFrom('\n', '\n\n'), {
        minLength: blocks.length,
        maxLength: blocks.length,
      })
      .map((gaps) =>
        blocks.map((value, index) => value + (gaps[index] ?? '')).join(''),
      ),
  );

describe('the serializer of the content policy', () => {
  it('writes every text so that the lexer reads back the same text', () => {
    fc.assert(
      fc.property(text, (value) => {
        const node: Inline = { kind: 'text', text: value };
        const read = readMarkdown(
          serializeBlocks([{ kind: 'paragraph', children: [node] }]),
        );
        expect(read).toEqual({
          ok: true,
          blocks: [{ kind: 'paragraph', children: [node] }],
        });
      }),
      run,
    );
  });

  it('keeps every text inside bold, italic, a heading and a cell', () => {
    const flat = text.map((value) => value.replaceAll('\n', ' '));
    fc.assert(
      fc.property(flat, (value) => {
        const node: Inline = { kind: 'text', text: value };
        const blocks = [
          {
            kind: 'paragraph',
            children: [
              { kind: 'text', text: 'a ' },
              { kind: 'strong', children: [node] },
              { kind: 'text', text: ' b ' },
              { kind: 'emphasis', children: [node] },
              { kind: 'text', text: ' c' },
            ],
          },
          { kind: 'heading', level: 2, children: [node] },
          {
            kind: 'table',
            align: [null],
            header: [[node]],
            rows: [[[node]]],
          },
        ] as const;
        const read = readMarkdown(serializeBlocks(blocks));
        expect(read.ok).toBe(true);
        if (!read.ok) return;
        // Bold and italic may come back merged with text of the same kind
        // around them, but a reader sees the same.
        expect(serializeBlocks(read.blocks)).toBe(serializeBlocks(blocks));
      }),
      run,
    );
  });
});

describe('checkMarkdown on generated documents', () => {
  it('gives a text that passes again unchanged, and never throws', () => {
    fc.assert(
      fc.property(
        fc.oneof(document, raw, fc.string({ maxLength: 200 })),
        (markdown) => {
          const first = checkMarkdown(markdown, options);
          if (!first.ok) {
            expect(first.violations.length).toBeGreaterThan(0);
            return;
          }
          expect(checkMarkdown(first.text, options)).toEqual(first);
        },
      ),
      run,
    );
  });
});

// Planted values that must never pass, in look-alike forms: letters and
// signs of full width, hidden characters between them, and emphasis
// around a part.
const fullWidth = (value: string): string =>
  Array.from(value)
    .map((sign) => {
      const code = sign.charCodeAt(0);
      return code > 0x20 && code < 0x7f
        ? String.fromCharCode(code + 0xfee0)
        : sign;
    })
    .join('');

const hidden = [
  '\u200b',
  '\u200d',
  '\u2060',
  '\ufeff',
  '\u00ad',
  '\ufe0f',
  '\u{e0041}',
];

const disguise = fc
  .tuple(fc.nat(2), fc.nat(), fc.constantFrom(...hidden))
  .map(([form, at, sign]) => (value: string): string => {
    if (form === 0) return fullWidth(value);
    if (form === 1) {
      const place = 1 + (at % (value.length - 1));
      return value.slice(0, place) + sign + value.slice(place);
    }
    return value;
  });

const planted: readonly (readonly [string, string])[] = [
  ['https://example.org/p?d=1', 'webAddress'],
  ['www.example.org', 'webAddress'],
  ['anmeldung.example.org', 'webAddress'],
  ['max.mustermann@example.org', 'contact'],
  ['+41 00 000 12 34', 'contact'],
  ['[masked]', 'masked'],
];

describe('checkMarkdown on planted values', () => {
  it('refuses a web address, contact data and a mask in any disguise', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...planted),
        disguise,
        words,
        words,
        ([value, reason], hide, before, after) => {
          const result = checkMarkdown(
            `${before} ${hide(value)} ${after}`,
            options,
          );
          expect(result.ok).toBe(false);
          if (!result.ok) expect(result.violations).toContain(reason);
        },
      ),
      run,
    );
  });
});

// The canonical form of the check code of the marking (ADR 0032).
describe('canonicalMarkdown on generated documents', () => {
  it('gives every text that passes one form, which stays the same', () => {
    fc.assert(
      fc.property(document, (value) => {
        const checked = checkMarkdown(value, options);
        fc.pre(checked.ok);
        const form = canonicalMarkdown(checked.text);
        expect(form).toBeDefined();
        expect(canonicalMarkdown(value)).toBe(form);
        expect(canonicalMarkdown(form ?? '')).toBe(form);
      }),
      run,
    );
  });

  it('changes when a word is added', () => {
    fc.assert(
      fc.property(document, word, (value, extra) => {
        const checked = checkMarkdown(value, options);
        fc.pre(checked.ok);
        expect(canonicalMarkdown(`${checked.text}\n${extra}`)).not.toBe(
          canonicalMarkdown(checked.text),
        );
      }),
      run,
    );
  });
});
