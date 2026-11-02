import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { checkPolicy } from './check.js';
import {
  minProposedPerDay,
  type ProposedCategory,
  proposedMaxPerDay,
  renderPolicyProposal,
} from './proposal.js';
import type { Policy } from './schema.js';
import { readPolicyYaml } from './yaml.js';

const create = 'ct_wiki_page_create';
const update = 'ct_wiki_page_update';

/** Reads a proposal with the real reader and checker of the policy. */
const load = (text: string): Policy => {
  const read = readPolicyYaml(text);
  if (!read.ok) throw new Error(`yaml: ${read.code}`);
  const checked = checkPolicy(read.value);
  if (!checked.ok) throw new Error(`policy: ${checked.code}`);
  return checked.policy;
};

const category = (
  id: number,
  name: string | undefined,
  tools: readonly string[] = [create],
  highestPerDay = 1,
): ProposedCategory => ({ id, name, tools, highestPerDay });

// The characters the writers of the command line pass to a terminal.
const shown = (line: string): boolean => {
  for (let index = 0; index < line.length; index += 1) {
    const code = line.charCodeAt(index);
    if (
      !(code >= 0x20 && code <= 0x7e) &&
      ![
        0xab, 0xbb, 0xc4, 0xd6, 0xdc, 0xe4, 0xf6, 0xfc, 0x2039, 0x203a,
      ].includes(code)
    ) {
      return false;
    }
  }
  return true;
};

describe('the daily limit of a proposal', () => {
  it.each([
    [0, 5],
    [2, 5],
    [3, 6],
    [10, 20],
    [500, 1000],
    [501, 1000],
    [Number.NaN, 5],
    [1.5, 5],
  ])('gives %d calls a day the limit %d', (highest, limit) => {
    expect(proposedMaxPerDay(highest)).toBe(limit);
  });

  it('never goes below the lowest limit', () => {
    expect(minProposedPerDay).toBe(5);
  });
});

describe('a proposal', () => {
  it('has one entry per category, sorted, with its tools once and sorted', () => {
    const text = renderPolicyProposal({
      categories: [
        category(20, 'Protokolle', [update, create, update], 4),
        category(12, 'Berichte', [create], 1),
      ],
      readBudgetPerDay: 150,
      days: { first: '2026-10-01', last: '2026-11-02' },
    });
    expect(text).toContain(
      '# Grundlage: die Audit-Dateien vom 2026-10-01 bis 2026-11-02 (UTC).',
    );
    const policy = load(text);
    expect(policy.interactive).toEqual({
      readBudgetPerDay: 150,
      targets: [
        {
          target: { kind: 'wiki_category', id: 12, name: 'Berichte' },
          tools: [create],
          maxPerDay: 5,
        },
        {
          target: { kind: 'wiki_category', id: 20, name: 'Protokolle' },
          tools: [create, update],
          maxPerDay: 8,
        },
      ],
    });
    expect(policy.unattended).toEqual([]);
  });

  it('writes an empty list without categories, and says what that allows', () => {
    const text = renderPolicyProposal({
      categories: [],
      readBudgetPerDay: 200,
    });
    expect(text).toContain('# Grundlage: Das Audit enthält keine Zeile.');
    expect(text).toContain('ausser bei Gruppen und Diensten');
    expect(load(text).interactive).toEqual({
      readBudgetPerDay: 200,
      targets: [],
    });
  });

  it('takes no days of another form into its comment', () => {
    const text = renderPolicyProposal({
      categories: [],
      readBudgetPerDay: 200,
      days: { first: '2026-10-01\nschema: x', last: '2026-11-02' },
    });
    expect(text).not.toContain('schema: x');
    expect(text).toContain('Das Audit enthält keine Zeile.');
  });

  it.each([
    ['quotes and a backslash', 'Bericht "A" \\ B'],
    ['umlauts and the quotes of the command line', 'Gemeindebüro «Süd» ‹Ö›'],
    ['a dash, a sharp s and an accent', 'Jugend – Straße, Café'],
    ['a character beyond the plane of the basics', 'Lobpreis 🎵'],
    ['YAML of its own', 'a: b, # c } { [d]'],
    ['a decomposed umlaut, read back in NFC', 'Büro'],
  ])(
    'keeps a name with %s exactly and shows only characters of the terminal',
    (_name, name) => {
      const text = renderPolicyProposal({
        categories: [category(7, name)],
        readBudgetPerDay: 200,
      });
      for (const line of text.split('\n')) expect(shown(line), line).toBe(true);
      expect(load(text).interactive.targets[0]?.target).toEqual({
        kind: 'wiki_category',
        id: 7,
        name: name.normalize('NFC'),
      });
    },
  );

  it.each([
    ['without a name', undefined, 'ChurchTools nennt dem Konto keinen Namen'],
    ['with an empty name', '', 'Ihr Name passt nicht'],
    ['with a control character', 'Bericht\tA', 'Ihr Name passt nicht'],
    ['with half a surrogate pair', 'Bericht \uD83C', 'Ihr Name passt nicht'],
    ['with a name too long', 'x'.repeat(256), 'Ihr Name passt nicht'],
  ])('writes a category %s only as a comment', (_name, name, reason) => {
    const text = renderPolicyProposal({
      categories: [category(9, name), category(12, 'Berichte')],
      readBudgetPerDay: 200,
    });
    expect(text).toContain(`# Kategorie 9: ${reason}`);
    for (const line of text.split('\n')) expect(shown(line), line).toBe(true);
    expect(load(text).interactive.targets.map((entry) => entry.target)).toEqual(
      [{ kind: 'wiki_category', id: 12, name: 'Berichte' }],
    );
  });

  it('leaves out a tool the policy would refuse, and a category without a tool', () => {
    const text = renderPolicyProposal({
      categories: [
        category(12, 'Berichte', ['ct_Bad', 'other', create]),
        category(13, 'Andere', ['ct_Bad']),
      ],
      readBudgetPerDay: 200,
    });
    expect(text).not.toContain('ct_Bad');
    expect(load(text).interactive.targets).toEqual([
      {
        target: { kind: 'wiki_category', id: 12, name: 'Berichte' },
        tools: [create],
        maxPerDay: 5,
      },
    ]);
  });

  it('takes at most 20 tools of an entry', () => {
    const tools = Array.from(
      { length: 25 },
      (_, index) => `ct_tool_${String(index).padStart(2, '0')}`,
    );
    const text = renderPolicyProposal({
      categories: [category(12, 'Berichte', tools)],
      readBudgetPerDay: 200,
    });
    expect(load(text).interactive.targets[0]?.tools).toHaveLength(20);
  });

  it('takes at most 200 entries and counts the rest in a comment', () => {
    const categories = Array.from({ length: 203 }, (_, index) =>
      category(index + 1, `Kategorie ${String(index + 1)}`),
    );
    const text = renderPolicyProposal({ categories, readBudgetPerDay: 200 });
    expect(text).toContain('# Weitere 3 Kategorien passen nicht mehr');
    expect(load(text).interactive.targets).toHaveLength(200);
  });

  it('reads back every name it takes, and comments out every other', () => {
    fc.assert(
      fc.property(
        fc.string({ unit: 'binary', minLength: 0, maxLength: 40 }),
        (name) => {
          const text = renderPolicyProposal({
            categories: [category(5, name)],
            readBudgetPerDay: 200,
          });
          for (const line of text.split('\n')) {
            if (!shown(line)) return false;
          }
          const targets = load(text).interactive.targets;
          if (targets.length === 0) return text.includes('# Kategorie 5:');
          return (
            JSON.stringify(targets[0]?.target) ===
            JSON.stringify({
              kind: 'wiki_category',
              id: 5,
              name: name.normalize('NFC'),
            })
          );
        },
      ),
    );
  });
});
