import type { IsoDate } from '@ecclium/mcp-churchtools-plugin-api';
import { describe, expect, it } from 'vitest';

import { contentHashOf } from './plan-hash.js';
import { isAsLeft, undoTargetOf, withdrawalNoteOf } from './undo.js';

const guid = '00000000-0000-4000-8000-0000000000AB';
const day = '2026-11-02' as IsoDate;
const today = '2026-11-03' as IsoDate;

const changed = {
  before: {
    kind: 'wikiPageText',
    tool: 'ct_wiki_page_update',
    categoryId: 12,
    guid,
    before: { version: 3, text: '# Plan\n' },
    after: { version: 4, textHash: contentHashOf(['# Neu\n']) },
  },
  day,
} as const;

const created = {
  before: {
    kind: 'wikiPageCreate',
    tool: 'ct_wiki_page_create',
    categoryId: 12,
    title: 'Bericht',
    textHash: contentHashOf(['# Bericht\n']),
  },
  after: { kind: 'wikiPageCreated', guid, version: 1 },
  day,
} as const;

const targetOf = (snapshot: Parameters<typeof undoTargetOf>[0]) => {
  const found = undoTargetOf(snapshot);
  if (!found.ok) throw new Error('no target');
  return found.target;
};

describe('the target of an undo (ADR 0031)', () => {
  it('writes back the text from before a change, unchanged', () => {
    const target = targetOf(changed);
    expect(target).toMatchObject({
      categoryId: 12,
      guid,
      tool: 'ct_wiki_page_update',
      left: { version: 4, textHash: contentHashOf(['# Neu\n']) },
    });
    expect(target.textOn(today)).toBe('# Plan\n');
    expect(target.done('# Plan\n')).toBe(true);
    expect(target.done('# Neu\n')).toBe(false);
  });

  it('withdraws a new page with a fixed sentence, leaving its title', () => {
    const target = targetOf(created);
    expect(target).toMatchObject({
      categoryId: 12,
      guid,
      tool: 'ct_wiki_page_create',
      left: { version: 1, textHash: contentHashOf(['# Bericht\n']) },
    });
    expect(target.textOn(today)).toBe(
      'Diese Seite hat Ecclium am 02.11.2026 angelegt und am 03.11.2026 zurückgenommen.\n',
    );
    // Taken back on any later day, it is done.
    expect(target.done(withdrawalNoteOf(day, '2026-12-01' as IsoDate))).toBe(
      true,
    );
    // Not for a page created on another day, nor for another text.
    expect(target.done(withdrawalNoteOf('2026-11-01' as IsoDate, today))).toBe(
      false,
    );
    expect(target.done('# Bericht\n')).toBe(false);
  });

  it('gives only the category of a new page whose GUID was never kept', () => {
    expect(undoTargetOf({ before: created.before, day })).toEqual({
      ok: false,
      categoryId: 12,
    });
  });

  it('tells a page as the write left it from one changed since', () => {
    const target = targetOf(changed);
    expect(isAsLeft(target, { version: 4, text: '# Neu\n' })).toBe(true);
    expect(isAsLeft(target, { version: 5, text: '# Neu\n' })).toBe(false);
    expect(isAsLeft(target, { version: 4, text: '# Anders\n' })).toBe(false);
  });

  it('writes a sentence that the content policy keeps as it is', () => {
    for (const [from, to] of [
      ['2026-01-01', '2026-12-31'],
      ['2026-02-28', '2026-03-30'],
    ] as const) {
      const note = withdrawalNoteOf(from as IsoDate, to as IsoDate);
      expect(note.endsWith(' zurückgenommen.\n')).toBe(true);
    }
    // A day that is none, which the content policy would write otherwise.
    expect(() => withdrawalNoteOf('2026-11-0*' as IsoDate, today)).toThrow(
      TypeError,
    );
  });
});
