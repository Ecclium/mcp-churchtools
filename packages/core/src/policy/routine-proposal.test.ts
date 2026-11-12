import { describe, expect, it } from 'vitest';

import { readConfigYaml } from '../config/yaml.js';
import { checkPolicy } from './check.js';
import {
  renderRoutineProposal,
  type RoutineProposalInput,
  type RoutineProposalNote,
  routineMaxPerDay,
} from './routine-proposal.js';
import type { Policy } from './schema.js';

const tool = 'ct_wiki_page_append_section';
const guid = '00000000-0000-4000-8000-0000000000c1';

const input = (
  fields: Partial<RoutineProposalInput> = {},
): RoutineProposalInput => ({
  routine: 'dienstplan-report',
  credential: 'berichte',
  tool,
  page: { categoryId: 7, guid, name: 'Dienstplan-Auswertung' },
  triggersPerDay: 1,
  notes: [],
  ...fields,
});

/** Reads a text with the real reader and checker of the policy. */
const load = (text: string): Policy => {
  const read = readConfigYaml(text);
  if (!read.ok) throw new Error(`yaml: ${read.code}`);
  const checked = checkPolicy(read.value);
  if (!checked.ok) throw new Error(`policy: ${checked.code}`);
  return checked.policy;
};

/** The proposal added to a file of the policy, as the operator does. */
const inPolicy = (text: string): Policy =>
  load(`schema: policy.v1\nunattended:\n${text}`);

// The characters the writers of the command line pass to a terminal.
const shown = (line: string): boolean =>
  Array.from({ length: line.length }, (_, index) =>
    line.charCodeAt(index),
  ).every((code) => {
    return (
      (code >= 0x20 && code <= 0x7e) ||
      [0xab, 0xbb, 0xc4, 0xd6, 0xdc, 0xe4, 0xf6, 0xfc, 0x2039, 0x203a].includes(
        code,
      )
    );
  });

const comments = (text: string): readonly string[] =>
  text.split('\n').filter((line) => line.startsWith('#'));

describe('the daily limit of a proposal for a routine', () => {
  it.each([
    [1, 2],
    [2, 3],
    [25, 26],
    [999, 1000],
    [1000, 1000],
    [0, 1],
    [-3, 1],
    [1.5, 1],
    [Number.NaN, 1],
    [Number.POSITIVE_INFINITY, 1],
  ])('gives %s triggers a day the limit %s', (triggers, limit) => {
    expect(routineMaxPerDay(triggers)).toBe(limit);
  });
});

describe('renderRoutineProposal', () => {
  it('writes one entry that the policy takes once added to its list', () => {
    const text = renderRoutineProposal(input());
    const policy = inPolicy(text);
    expect(policy.unattended).toEqual([
      {
        routine: 'dienstplan-report',
        credential: 'berichte',
        modelRedaction: 'strict',
        target: {
          kind: 'wiki_page',
          categoryId: 7,
          guid,
          name: 'Dienstplan-Auswertung',
        },
        tools: [tool],
        maxPerRun: 1,
        maxPerDay: 2,
      },
    ]);
    expect(text.endsWith('maxPerDay: 2\n')).toBe(true);
    // Alone it is no policy, so it never replaces the file in force.
    expect(() => load(text)).toThrow('policy:');
    expect(text).not.toContain('modelRedaction:');
    expect(text).not.toContain('acceptRightsDrift');
    expect(text.split('\n').every(shown)).toBe(true);
  });

  it('gives maxPerDay one more than the most triggers of a day', () => {
    const policy = inPolicy(
      renderRoutineProposal(input({ triggersPerDay: 25 })),
    );
    expect(policy.unattended[0]?.maxPerDay).toBe(26);
    expect(policy.unattended[0]?.maxPerRun).toBe(1);
  });

  it('writes the GUID in small letters and a name with escapes', () => {
    const name = 'Bericht "neu" \\ «Gemeinde» Zürich \u{1f600}';
    const text = renderRoutineProposal(
      input({
        page: { categoryId: 12, guid: guid.toUpperCase(), name },
      }),
    );
    const policy = inPolicy(text);
    expect(policy.unattended[0]?.target).toEqual({
      kind: 'wiki_page',
      categoryId: 12,
      guid,
      name,
    });
    expect(text).toContain('\\u00A0');
    expect(text).toContain('\\U0001F600');
    expect(text.split('\n').every(shown)).toBe(true);
  });

  it('writes no entry without a page, only the header and the notes', () => {
    const text = renderRoutineProposal(
      input({ page: undefined, notes: [{ kind: 'category_missing' }] }),
    );
    expect(text.split('\n').filter((line) => line !== '')).toEqual(
      comments(text),
    );
    expect(text).not.toContain('maxPerRun ist 1');
    expect(comments(text).at(-1)).toContain('output.scope.category');
  });

  it('writes the notes once each, in a fixed order', () => {
    const all: readonly RoutineProposalNote[] = [
      { kind: 'checks' },
      { kind: 'redaction_standard' },
      { kind: 'existing', count: 1, otherCredential: false },
      { kind: 'names_changed' },
      { kind: 'list_too_long', entries: 1000 },
      { kind: 'page_ambiguous' },
      { kind: 'page_missing' },
      { kind: 'category_missing' },
      { kind: 'checks' },
    ];
    const notes = comments(
      renderRoutineProposal(input({ page: undefined, notes: all })),
    ).slice(3);
    expect(notes).toHaveLength(8);
    expect(notes[0]).toContain('output.scope.category');
    expect(notes[1]).toContain('Legen Sie die Seite von Hand an');
    expect(notes[2]).toContain('Mehr als eine Seite');
    expect(notes[3]).toContain('länger als die 1000 Einträge');
    expect(notes[4]).toContain('verändert an');
    expect(notes[5]).toContain('hat schon einen Eintrag für diese Routine.');
    expect(notes[6]).toContain('modelRedaction: standard');
    expect(notes[7]).toContain('feste Prüfungen');
    expect(notes.every(shown)).toBe(true);
  });

  it('names more entries of the routine and another account', () => {
    const [note] = comments(
      renderRoutineProposal(
        input({
          notes: [{ kind: 'existing', count: 2, otherCredential: true }],
        }),
      ),
    ).slice(4);
    expect(note).toContain(
      'hat schon 2 Einträge für diese Routine, mit einem anderen Konto. Ersetzen Sie sie',
    );
  });

  it('keeps the entry beside notes for the operator', () => {
    const text = renderRoutineProposal(
      input({ notes: [{ kind: 'redaction_standard' }, { kind: 'checks' }] }),
    );
    expect(inPolicy(text).unattended).toHaveLength(1);
    expect(comments(text)).toHaveLength(6);
  });

  it.each([
    ['a GUID of another form', { categoryId: 7, guid: 'c1', name: 'Bericht' }],
    ['the category 0', { categoryId: 0, guid, name: 'Bericht' }],
    ['a category too high', { categoryId: 2_147_483_648, guid, name: 'B' }],
    ['a category no integer', { categoryId: 7.5, guid, name: 'Bericht' }],
    ['an empty name', { categoryId: 7, guid, name: '' }],
    ['a name too long', { categoryId: 7, guid, name: 'x'.repeat(256) }],
    ['a control character', { categoryId: 7, guid, name: 'Be\u0007richt' }],
    ['half of a surrogate', { categoryId: 7, guid, name: 'Be\ud800richt' }],
  ])('writes no entry for %s', (_case, page) => {
    const text = renderRoutineProposal(input({ page }));
    expect(comments(text).at(-1)).toBe(
      '# Kennung oder Name der Seite passen nicht in die Richtlinie. Darum kein Eintrag.',
    );
    expect(text).not.toContain('- routine:');
    expect(text.split('\n').every(shown)).toBe(true);
  });

  it.each([
    ['routine', { routine: 'Dienstplan' }],
    ['alias', { credential: 'b\nc' }],
    ['tool', { tool: 'wiki_append' }],
  ])('refuses a %s of another form', (_case, fields) => {
    expect(() => renderRoutineProposal(input(fields))).toThrow(TypeError);
  });
});
