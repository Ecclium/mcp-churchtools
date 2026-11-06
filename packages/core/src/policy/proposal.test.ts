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

/** Whether the real reader and checker take a text. */
const loads = (text: string): boolean => {
  const read = readPolicyYaml(text);
  return read.ok && checkPolicy(read.value).ok;
};

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

  it('writes a category whose name the redaction changed only as a comment', () => {
    const text = renderPolicyProposal({
      categories: [
        { ...category(9, 'Kontakt [email masked]'), nameChanged: true },
        category(12, 'Berichte'),
      ],
      readBudgetPerDay: 200,
    });
    expect(text).toContain('# Kategorie 9: Ihr Name kam verändert an');
    expect(load(text).interactive.targets.map((entry) => entry.target)).toEqual(
      [{ kind: 'wiki_category', id: 12, name: 'Berichte' }],
    );
  });

  it('keeps a file from loading when every category the audit names fell out', () => {
    const text = renderPolicyProposal({
      categories: [category(9, undefined), category(10, 'Bericht\tA')],
      readBudgetPerDay: 200,
    });
    expect(text).toContain('# Keine Kategorie liess sich vorschlagen');
    expect(text).toContain('# Kategorie 9:');
    expect(text).toContain('# Kategorie 10:');
    expect(loads(text)).toBe(false);
  });

  it('marks a target that the audit shows only refused', () => {
    const text = renderPolicyProposal({
      categories: [category(12, 'Berichte', [create], 0)],
      readBudgetPerDay: 200,
    });
    const lines = text.split('\n');
    const entry = lines.indexOf(
      '    - target: { kind: wiki_category, id: 12, name: "Berichte" }',
    );
    expect(lines[entry - 1]).toBe(
      '    # Nur abgelehnte oder übersprungene Versuche im Audit: Prüfen Sie, ob Ecclium hier schreiben soll.',
    );
    expect(load(text).interactive.targets).toHaveLength(1);
  });

  it('puts the targets before the read budget, so that a cut text does not load', () => {
    const text = renderPolicyProposal({
      categories: [category(12, 'Berichte')],
      readBudgetPerDay: 150,
    });
    const lines = text.split('\n');
    expect(lines.indexOf('  targets:')).toBeLessThan(
      lines.indexOf('  readBudgetPerDay: 150'),
    );
    const cut = `${lines.slice(0, lines.indexOf('  targets:') + 1).join('\n')}\n`;
    expect(loads(cut)).toBe(false);
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

  it('names calendars and resources after the categories, each kind sorted', () => {
    const appointments = 'ct_appointments_create';
    const bookings = 'ct_bookings_create';
    const text = renderPolicyProposal({
      categories: [category(12, 'Berichte')],
      calendars: [
        category(9, 'Jugend', [appointments], 3),
        category(8, 'Gottesdienste', [appointments, 'ct_appointments_update']),
      ],
      resources: [category(13, 'Saal «Süd»', [bookings], 0)],
      readBudgetPerDay: 200,
    });
    expect(text).toContain(
      '# Ein Eintrag je Kategorie des Wikis, je Kalender und je Ressource, die das Audit in einer Zeile eines Schreib-Tools nennt, auch bei abgelehnten Versuchen.',
    );
    expect(text).toContain(
      '    - target: { kind: calendar, id: 8, name: "Gottesdienste" }',
    );
    expect(load(text).interactive.targets).toEqual([
      {
        target: { kind: 'wiki_category', id: 12, name: 'Berichte' },
        tools: [create],
        maxPerDay: 5,
      },
      {
        target: { kind: 'calendar', id: 8, name: 'Gottesdienste' },
        tools: [appointments, 'ct_appointments_update'],
        maxPerDay: 5,
      },
      {
        target: { kind: 'calendar', id: 9, name: 'Jugend' },
        tools: [appointments],
        maxPerDay: 6,
      },
      {
        target: { kind: 'resource', id: 13, name: 'Saal «Süd»' },
        tools: [bookings],
        maxPerDay: 5,
      },
    ]);
  });

  it('comments out a calendar or a resource without a fitting name, in its own words', () => {
    const text = renderPolicyProposal({
      categories: [],
      calendars: [
        category(8, undefined),
        { ...category(9, 'Jug\u200Bend'), nameChanged: true },
        category(10, 'Kalender\tA'),
      ],
      resources: [category(13, undefined), category(14, 'Saal\tB')],
      readBudgetPerDay: 200,
    });
    expect(text).toContain('# Kein Ziel liess sich vorschlagen');
    for (const line of [
      '    # Kalender 8: ChurchTools nennt dem Konto keinen Namen, darum kein Eintrag.',
      '    # Kalender 9: Sein Name kam verändert an, ohne unsichtbare Zeichen oder mit einem maskierten Teil, darum kein Eintrag. Tragen Sie ihn von Hand ein.',
      '    # Kalender 10: Sein Name passt nicht in die Richtlinie, darum kein Eintrag.',
      '    # Ressource 13: ChurchTools nennt dem Konto keinen Namen, darum kein Eintrag.',
      '    # Ressource 14: Ihr Name passt nicht in die Richtlinie, darum kein Eintrag.',
    ]) {
      expect(text.split('\n')).toContain(line);
    }
    expect(loads(text)).toBe(false);
  });

  it('counts calendars and resources in the 200 entries of a part', () => {
    const calendars = Array.from({ length: 150 }, (_, index) =>
      category(index + 1, `Kalender ${String(index + 1)}`),
    );
    const resources = Array.from({ length: 52 }, (_, index) =>
      category(index + 1, `Ressource ${String(index + 1)}`),
    );
    const text = renderPolicyProposal({
      categories: [],
      calendars,
      resources,
      readBudgetPerDay: 200,
    });
    expect(text).toContain('# Weitere 2 Ziele passen nicht mehr');
    expect(load(text).interactive.targets).toHaveLength(200);
  });

  it('keeps the words of the wiki for categories alone, also with empty lists', () => {
    const input = {
      categories: [category(12, 'Berichte')],
      readBudgetPerDay: 200,
    };
    expect(
      renderPolicyProposal({ ...input, calendars: [], resources: [] }),
    ).toBe(renderPolicyProposal(input));
  });

  it('keeps the contact values of the policy in force', () => {
    const contacts = ['sekretariat@example.org', '+41 00 000 12 34'];
    const text = renderPolicyProposal({
      categories: [category(12, 'Berichte')],
      readBudgetPerDay: 200,
      contacts,
    });
    expect(load(text).interactive.contacts).toEqual(contacts);
    expect(
      renderPolicyProposal({
        categories: [category(12, 'Berichte')],
        readBudgetPerDay: 200,
        contacts: [],
      }),
    ).not.toContain('contacts');
  });

  it('keeps whom to ask of the policy in force', () => {
    const text = renderPolicyProposal({
      categories: [category(12, 'Berichte')],
      readBudgetPerDay: 200,
      contacts: ['sekretariat@example.org'],
      inquiriesTo: 'Sekretariat «Pfarramt», sekretariat@example.org',
    });
    expect(load(text).interactive.inquiriesTo).toBe(
      'Sekretariat «Pfarramt», sekretariat@example.org',
    );
    expect(
      renderPolicyProposal({
        categories: [category(12, 'Berichte')],
        readBudgetPerDay: 200,
      }),
    ).not.toContain('inquiriesTo');
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
          // A name that falls out leaves no category, and the file then
          // does not load until someone enters the targets.
          if (text.includes('    - ERSETZEN')) {
            return !loads(text) && text.includes('# Kategorie 5:');
          }
          const targets = load(text).interactive.targets;
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
