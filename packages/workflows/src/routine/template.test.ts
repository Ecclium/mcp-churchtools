import { describe, expect, it } from 'vitest';

import type { RoutineBlock } from './schema.js';
import { parseTemplate, templateCodes } from './template.js';

// The blocks of a report of the service plan, as a routine names them.
const blocks: Readonly<Record<string, RoutineBlock>> = {
  unbesetzt: {
    maxItems: 30,
    fields: {
      datum: { type: 'date' },
      dienst: { type: 'text', maxLength: 80 },
    },
  },
  mehrfach: {
    maxItems: 30,
    fields: {
      person: { type: 'person' },
      anzahl: { type: 'integer', min: 2, max: 50 },
    },
  },
};

const report = [
  '### Dienstplan {{period}}',
  '',
  '#### Unbesetzte Dienste',
  '{{#unbesetzt}}',
  '- {{datum}}: {{dienst}}',
  '{{/unbesetzt}}',
  '{{^unbesetzt}}',
  'Alle Dienste sind besetzt.',
  '{{/unbesetzt}}',
  '',
  '#### Mehrfach eingeteilt',
  '  {{#mehrfach}}  ',
  '- {{person}} ({{anzahl}}-mal in {{period}})',
  '\t{{/mehrfach}}',
  '',
].join('\n');

describe('parseTemplate with a valid template', () => {
  it('parses text, the period, sections and fields, deeply frozen', () => {
    const result = parseTemplate(report, blocks);
    expect(result).toEqual({
      ok: true,
      template: {
        parts: [
          { kind: 'text', text: '### Dienstplan ' },
          { kind: 'period' },
          { kind: 'text', text: '\n\n#### Unbesetzte Dienste\n' },
          {
            kind: 'repeat',
            block: 'unbesetzt',
            parts: [
              { kind: 'text', text: '- ' },
              { kind: 'field', field: 'datum' },
              { kind: 'text', text: ': ' },
              { kind: 'field', field: 'dienst' },
              { kind: 'text', text: '\n' },
            ],
          },
          {
            kind: 'empty',
            block: 'unbesetzt',
            parts: [{ kind: 'text', text: 'Alle Dienste sind besetzt.\n' }],
          },
          { kind: 'text', text: '\n#### Mehrfach eingeteilt\n' },
          {
            kind: 'repeat',
            block: 'mehrfach',
            parts: [
              { kind: 'text', text: '- ' },
              { kind: 'field', field: 'person' },
              { kind: 'text', text: ' (' },
              { kind: 'field', field: 'anzahl' },
              { kind: 'text', text: '-mal in ' },
              { kind: 'period' },
              { kind: 'text', text: ')\n' },
            ],
          },
        ],
      },
    });
    const frozen = (value: unknown): boolean =>
      typeof value !== 'object' ||
      value === null ||
      (Object.isFrozen(value) && Object.values(value).every(frozen));
    expect(frozen(result)).toBe(true);
  });

  it('reads lines that end with a carriage return and a line feed', () => {
    const windows = parseTemplate(report.replaceAll('\n', '\r\n'), blocks);
    expect(windows).toEqual(parseTemplate(report, blocks));
  });

  it('takes the period inside an empty section', () => {
    const result = parseTemplate(
      [
        '{{#unbesetzt}}',
        '{{dienst}}',
        '{{/unbesetzt}}',
        '{{^unbesetzt}}',
        'Nichts offen in {{period}}.',
        '{{/unbesetzt}}',
        '{{#mehrfach}}',
        '{{person}}',
        '{{/mehrfach}}',
      ].join('\n'),
      blocks,
    );
    expect(result.ok).toBe(true);
  });

  it('takes a block that repeats twice', () => {
    const result = parseTemplate(
      '{{#unbesetzt}}\n{{datum}}\n{{/unbesetzt}}\n{{#unbesetzt}}\n{{dienst}}\n{{/unbesetzt}}\n{{#mehrfach}}\n{{/mehrfach}}',
      blocks,
    );
    expect(result.ok).toBe(true);
  });
});

describe('parseTemplate with a template it refuses', () => {
  const body = '{{#mehrfach}}\n{{person}}\n{{/mehrfach}}\n';
  const withLine = (line: string): string =>
    `Bericht\n{{#unbesetzt}}\n${line}\n{{/unbesetzt}}\n${body}`;

  it.each([
    ['three braces', '{{{dienst}}}', 'template_tag'],
    ['a partial', '{{>kopf}}', 'template_tag'],
    ['a comment', '{{! Notiz }}', 'template_tag'],
    ['an unescaped field', '{{&dienst}}', 'template_tag'],
    ['new delimiters', '{{=<% %>=}}', 'template_tag'],
    ['spaces in a tag', '{{ dienst }}', 'template_tag'],
    ['a name in upper case', '{{Dienst}}', 'template_tag'],
    ['an open tag', '- {{dienst', 'template_tag'],
    ['braces in text', 'Mengen wie {{a, b}}', 'template_tag'],
    ['a section within a line', '- {{#mehrfach}}', 'template_section_line'],
    [
      'a section end within a line',
      'Ende {{/unbesetzt}}',
      'template_section_line',
    ],
    ['a field of another block', '- {{person}}', 'template_field_unknown'],
    ['a field nobody named', '- {{ort}}', 'template_field_unknown'],
    ['a control character', '- {{dienst}}\u0007', 'template_characters'],
    ['a carriage return alone', '- {{dienst}}\rx', 'template_characters'],
  ])('refuses %s in line 3', (_name, line, code) => {
    expect(parseTemplate(withLine(line), blocks)).toEqual({
      ok: false,
      code,
      line: 3,
    });
  });

  it('refuses a field outside a repeating section', () => {
    expect(parseTemplate(`{{dienst}}\n${body}`, blocks)).toEqual({
      ok: false,
      code: 'template_field_unknown',
      line: 1,
    });
    expect(
      parseTemplate(
        `{{^unbesetzt}}\n{{dienst}}\n{{/unbesetzt}}\n${body}`,
        blocks,
      ),
    ).toEqual({ ok: false, code: 'template_field_unknown', line: 2 });
  });

  it('refuses a section of a block the routine does not fill', () => {
    expect(parseTemplate(`{{#offen}}\n{{/offen}}\n${body}`, blocks)).toEqual({
      ok: false,
      code: 'template_block_unknown',
      line: 1,
    });
  });

  it.each([
    [
      'a section within a section',
      '{{#unbesetzt}}\n{{#mehrfach}}\n{{/mehrfach}}\n{{/unbesetzt}}',
      2,
    ],
    ['an end without a start', '{{/unbesetzt}}', 1],
    ['the end of another block', '{{#unbesetzt}}\n{{/mehrfach}}', 2],
    ['a section that never ends', `${body}{{#unbesetzt}}\n- x`, 5],
  ])('refuses %s', (_name, text, line) => {
    expect(parseTemplate(text, blocks)).toEqual({
      ok: false,
      code: 'template_nesting',
      line,
    });
  });

  it('refuses a template that never repeats a block', () => {
    expect(parseTemplate(body, blocks)).toEqual({
      ok: false,
      code: 'template_block_unused',
    });
    expect(
      parseTemplate(`{{^unbesetzt}}\nleer\n{{/unbesetzt}}\n${body}`, blocks),
    ).toEqual({ ok: false, code: 'template_block_unused' });
  });

  it('refuses a text that is not a string', () => {
    expect(() => parseTemplate(1 as unknown as string, blocks)).toThrow(
      TypeError,
    );
  });

  it('has frozen and unique codes', () => {
    expect(Object.isFrozen(templateCodes)).toBe(true);
    expect(new Set(templateCodes).size).toBe(templateCodes.length);
  });
});
