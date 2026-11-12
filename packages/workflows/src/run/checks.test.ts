import type {
  Policy,
  RunCallOutcome,
  Trigger,
} from '@ecclium/mcp-churchtools-core';
import type { Logger } from '@ecclium/mcp-churchtools-plugin-api';
import { redactedOutcome } from '@ecclium/mcp-churchtools-testkit';
import { describe, expect, it } from 'vitest';

import { checkBlockFields, checkRoutine } from '../routine/check.js';
import type { LoadedRoutine } from '../routine/loader.js';
import type { RoutineCheck } from '../routine/schema.js';
import { parseTemplate } from '../routine/template.js';
import {
  type CheckContext,
  hiddenTitle,
  mainPageName,
  runChecks,
  wikiLinksIn,
} from './checks.js';
import { executeRun } from './execute.js';
import type { RunRead } from './inputs.js';
import { prepareRun } from './prepare.js';

// The checks of the core on a stand-in of the reads (ADR 0033). The
// stand-in gives the fields the tools of the wiki give, with every text of
// the class untrusted in an envelope, as the pipeline does. All data are
// made up.

const origin = 'https://example.church.tools';
const context: CheckContext = { origin, timeZone: 'Europe/Zurich' };
const boundary = 'a1b2c3d4e5f6a7b8';
const wrap = (text: string): string =>
  `<<data-${boundary}>>${text}<</data-${boundary}>>`;

const silent: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const ok = (data: Readonly<Record<string, unknown>>): RunCallOutcome => {
  const made = redactedOutcome(data);
  if (!made.ok) throw new Error('no data');
  return { ok: true, data: made.data, entries: 1, more: false, persons: {} };
};

// 12.11.2026, 06:00 in Zurich.
const at = Date.UTC(2026, 10, 12, 5);

interface StandInPage {
  readonly guid: string;
  readonly title: string;
  readonly modifiedDate: string | null;
  readonly parts: readonly string[];
}

const wiki: Readonly<Record<number, readonly StandInPage[]>> = {
  1: [
    {
      guid: 'seite-ablauf',
      title: 'Ablauf',
      // 09.01.2024 at 23:30 in UTC is the 10th in Zurich.
      modifiedDate: '2024-01-09T23:30:00Z',
      parts: [
        [
          '[Besuch](/wiki/1/seite-besuch)',
          `[Fehlt](${origin}/wiki/1/Fehlt)`,
          '[Fremd](https://other.example.org/wiki/1/Fremd)',
          '[Haupt](/wiki/2/main)',
          '[Versteckt](/wiki/9/seite-x)',
          '[Titel](/wiki/1/Besuch)',
          '[Neu](/wiki/1/Neue%20Seite) und [Neu](/wiki/1/Neue%20Seite)',
          '<a href="/wiki/1/Weg">Weg</a> [Teil](/wiki/1/Ge',
        ].join('\n'),
        'teilt)\n',
      ],
    },
    {
      guid: 'seite-besuch',
      title: 'Besuch',
      modifiedDate: '2026-11-01T08:00:00Z',
      parts: ['Kein Link.'],
    },
  ],
  2: [
    {
      guid: 'seite-main',
      title: 'main',
      modifiedDate: '2026-11-01T08:00:00Z',
      parts: [''],
    },
    {
      guid: 'seite-pflege',
      title: 'Kontakt max.mustermann@example.org',
      modifiedDate: '2025-01-01T08:00:00Z',
      parts: ['[Ablauf](/wiki/1/seite-ablauf)'],
    },
  ],
};

const categories = [
  { id: 1, name: wrap('Gemeinde') },
  { id: 2, name: wrap('Berichte') },
];

// The reads of the stand-in, one list of pages per page of the list.
const standIn = (
  pages: Readonly<Record<number, readonly StandInPage[]>> = wiki,
  calls: { tool: string; input: unknown }[] = [],
): RunRead => {
  return (tool, input) => {
    calls.push({ tool, input });
    if (tool === 'ct_wiki_categories_list') {
      return Promise.resolve(
        ok({ page: input['page'], categories, more: false, notice: null }),
      );
    }
    if (tool === 'ct_wiki_pages_list') {
      // One page of the wiki per page of the list, to page through.
      const list = pages[input['categoryId'] as number] ?? [];
      const index = (input['page'] as number) - 1;
      const page = list[index];
      return Promise.resolve(
        ok({
          categoryId: input['categoryId'],
          page: input['page'],
          pages:
            page === undefined
              ? []
              : [
                  {
                    guid: page.guid,
                    title: wrap(page.title),
                    isMarkdown: true,
                    version: 2,
                    modifiedDate: page.modifiedDate,
                  },
                ],
          more: index + 1 < list.length,
          notice: null,
        }),
      );
    }
    const page = (pages[input['categoryId'] as number] ?? []).find(
      (item) => item.guid === input['guid'],
    );
    if (page === undefined) {
      return Promise.resolve({
        ok: false,
        code: 'not_found',
        transient: false,
      });
    }
    const part = input['part'] as number;
    return Promise.resolve(
      ok({
        categoryId: input['categoryId'],
        guid: page.guid,
        title: wrap(page.title),
        isMarkdown: true,
        version: 2,
        part,
        parts: page.parts.length,
        text: wrap(page.parts[part - 1] ?? ''),
      }),
    );
  };
};

const stale: RoutineCheck = {
  check: 'stalePages',
  olderThanDays: 365,
  maxItems: 10,
};
const links: RoutineCheck = { check: 'brokenLinks', maxItems: 10 };

const run = (
  checks: readonly RoutineCheck[],
  read: RunRead = standIn(),
): ReturnType<typeof runChecks> =>
  runChecks(checks, read, context, at, silent, new AbortController().signal);

describe('the links of a page to the own wiki', () => {
  it('are the paths of the wiki with the own origin or alone, each once', () => {
    expect(
      wikiLinksIn(
        [
          // As the editor of ChurchTools stores an address it links.
          `[${origin}/wiki/3/main](${origin}/wiki/3/main) [b](/wiki/3/Seite-B)`,
          '<a href="/wiki/4/Neue%20Seite">c</a> /wiki/4/Neue+Seite',
          '[d](/wiki/3/seite-b) [e](/wiki/3/Seite-E#abschnitt)',
          '[f](/wiki/3/Seite-F?x=1) [g](/wiki/3/Seite-G/edit)',
          `[h](${origin}/wiki/5) [i](/wiki/5/)`,
        ].join('\n'),
        origin,
      ),
    ).toEqual([
      { categoryId: 3, page: 'main' },
      { categoryId: 3, page: 'Seite-B' },
      { categoryId: 4, page: 'Neue Seite' },
      // A plus sign stays one in the path of an address.
      { categoryId: 4, page: 'Neue+Seite' },
      { categoryId: 3, page: 'Seite-E' },
      { categoryId: 3, page: 'Seite-F' },
      { categoryId: 3, page: 'Seite-G' },
      // The category alone shows its main page.
      { categoryId: 5, page: 'main' },
    ]);
  });

  it('leave out another host, a path inside a word and a broken path', () => {
    expect(
      wikiLinksIn(
        [
          '[a](https://other.example.org/wiki/3/main)',
          `[b](${origin}.evil.example/wiki/3/main)`,
          'x/wiki/3/main',
          '[c](/wiki/x/main) [d](/wiki/3x/main)',
          // The list of all pages and of all categories names no page.
          '[e](/wiki/3/sitemap) [f](/wiki/all) [g](/wiki/)',
        ].join('\n'),
        origin,
      ),
    ).toEqual([]);
  });

  it('keep a page whose escape is broken as it stands', () => {
    expect(wikiLinksIn('[a](/wiki/3/%E0%A4%A)', origin)).toEqual([
      { categoryId: 3, page: '%E0%A4%A' },
    ]);
  });
});

describe('the checks of the core', () => {
  it('report old pages and links without a target, in a fixed order', async () => {
    const calls: { tool: string; input: unknown }[] = [];
    const checked = await run([stale, links], standIn(wiki, calls));
    if (!checked.ok) throw new Error(checked.code);
    expect(checked.blocks).toEqual({
      stalePages: [
        { page: 'Ablauf', category: 'Gemeinde', changed: '10.01.2024' },
        // A title the content policy refuses gives way to a fixed text.
        { page: hiddenTitle, category: 'Berichte', changed: '01.01.2025' },
      ],
      brokenLinks: [
        { page: 'Gemeinde › Ablauf', link: 'Gemeinde › Fehlt' },
        { page: 'Gemeinde › Ablauf', link: 'Gemeinde › Geteilt' },
        { page: 'Gemeinde › Ablauf', link: 'Gemeinde › Neue Seite' },
        { page: 'Gemeinde › Ablauf', link: 'Gemeinde › Weg' },
        // A category the account does not see appears by its number.
        { page: 'Gemeinde › Ablauf', link: 'Kategorie 9 › seite-x' },
      ],
    });
    expect(checked.entries).toBe(7);
    // One list of categories, one page of a list per page of the wiki,
    // and every part of every page: two of «Ablauf», one of each other.
    expect(checked.calls).toBe(calls.length);
    expect(calls.map((call) => call.tool)).toEqual([
      'ct_wiki_categories_list',
      'ct_wiki_pages_list',
      'ct_wiki_pages_list',
      'ct_wiki_pages_list',
      'ct_wiki_pages_list',
      ...Array.from({ length: 5 }, () => 'ct_wiki_page_get'),
    ]);
  });

  it('read no page for stalePages alone', async () => {
    const calls: { tool: string; input: unknown }[] = [];
    const checked = await run([stale], standIn(wiki, calls));
    expect(checked.ok).toBe(true);
    expect(calls.map((call) => call.tool)).not.toContain('ct_wiki_page_get');
  });

  it('name the main page and keep at most maxItems entries', async () => {
    const checked = await run([
      { ...stale, maxItems: 1 },
      { check: 'brokenLinks', maxItems: 2 },
    ]);
    if (!checked.ok) throw new Error(checked.code);
    expect(checked.blocks['stalePages']).toHaveLength(1);
    expect(checked.blocks['brokenLinks']).toEqual([
      { page: 'Gemeinde › Ablauf', link: 'Gemeinde › Fehlt' },
      { page: 'Gemeinde › Ablauf', link: 'Gemeinde › Geteilt' },
    ]);
    expect(mainPageName).toBe('Hauptseite');
  });

  it('cut a value longer than its field with an ellipsis, between code points', async () => {
    const long = {
      1: [
        {
          guid: 'seite-lang',
          // Every sign outside the basic plane takes two code units.
          title: '𝄞'.repeat(300),
          modifiedDate: '2020-01-01T08:00:00Z',
          parts: [''],
        },
      ],
    };
    const checked = await run([stale], standIn(long));
    if (!checked.ok) throw new Error(checked.code);
    const page = checked.blocks['stalePages']?.[0]?.['page'] ?? '';
    expect(Array.from(page)).toHaveLength(255);
    expect(page).toBe(`${'𝄞'.repeat(254)}…`);
  });

  it('end the run when a page has no date and stalePages runs', async () => {
    const without = {
      ...wiki,
      2: [{ ...(wiki[2]?.[0] as StandInPage), modifiedDate: null }],
    };
    await expect(run([stale], standIn(without))).resolves.toEqual({
      ok: false,
      code: 'run_page_date_missing',
      transient: false,
    });
    // brokenLinks needs no date.
    expect((await run([links], standIn(without))).ok).toBe(true);
  });

  it('end the run past the limit of reads, never with a shorter report', async () => {
    const many = {
      1: Array.from({ length: 450 }, (_, index) => ({
        guid: `seite-${String(index)}`,
        title: `Seite ${String(index)}`,
        modifiedDate: '2026-11-01T08:00:00Z',
        parts: [''],
      })),
    };
    await expect(run([stale], standIn(many))).resolves.toEqual({
      ok: false,
      code: 'run_calls_exhausted',
      transient: false,
    });
  });

  it('end the run with the code of a read that fails', async () => {
    const failing: RunRead = () =>
      Promise.resolve({ ok: false, code: 'upstream', transient: true });
    await expect(run([stale], failing)).resolves.toEqual({
      ok: false,
      code: 'upstream',
      transient: true,
    });
  });

  it('pass over a page deleted after the list was read', async () => {
    const read = standIn();
    const deleting: RunRead = (tool, input, max, signal) =>
      tool === 'ct_wiki_page_get' && input['guid'] === 'seite-ablauf'
        ? Promise.resolve({ ok: false, code: 'not_found', transient: false })
        : read(tool, input, max, signal);
    const checked = await run([links], deleting);
    if (!checked.ok) throw new Error(checked.code);
    expect(checked.blocks['brokenLinks']).toEqual([]);
  });
});

describe('a run of a routine with the checks of the core', () => {
  const trigger: Trigger = {
    at,
    period: { isoWeek: '2026-W46', date: '2026-11-12', month: '2026-11' },
  };
  const policy = {
    schema: 'policy.v1',
    interactive: { readBudgetPerDay: 200, targets: [] },
    unattended: [],
  } as unknown as Policy;

  const loaded = (): LoadedRoutine => {
    const checked = checkRoutine({
      schema: 'routine.v1',
      id: 'pflege',
      schedule: '0 7 1 * *',
      checks: [stale, links],
      template: 't.md',
      output: {
        target: 'draft',
        channel: 'file',
        idempotencyKey: 'pflege:{month}',
      },
    });
    if (!checked.ok) throw new Error(checked.code);
    const parsed = parseTemplate(
      [
        '## Pflege {{period}}',
        '{{#stalePages}}',
        '- {{page}} ({{category}}), {{changed}}',
        '{{/stalePages}}',
        '{{#brokenLinks}}',
        '- {{page}}: {{link}}',
        '{{/brokenLinks}}',
        '',
      ].join('\n'),
      {
        stalePages: { maxItems: 10, fields: checkBlockFields.stalePages },
        brokenLinks: { maxItems: 10, fields: checkBlockFields.brokenLinks },
      },
    );
    if (!parsed.ok) throw new Error('invalid template');
    return { routine: checked.routine, template: parsed.template };
  };

  const prepared = () => {
    const made = prepareRun(loaded(), {
      tool: () => ({
        capability: 'read',
        routineStable: true,
        unattended: 'policy',
        params: ['categoryId', 'guid', 'page', 'part'],
        entryFields: [],
        paged: true,
      }),
      policy,
      models: new Set(),
    });
    if (!made.ok) throw new Error(made.code);
    return made.run;
  };

  it('renders the section without a model and names none', async () => {
    const result = await executeRun(
      prepared(),
      trigger,
      {
        read: standIn(),
        checks: context,
        policy,
        log: silent,
        clock: { now: () => at },
      },
      new AbortController().signal,
    );
    if (result.kind !== 'rendered') throw new Error(result.code);
    // The content policy writes a backslash only where a sign would
    // otherwise mark something up.
    expect(result.section).toBe(
      [
        '## Pflege 2026-11',
        '',
        '- Ablauf (Gemeinde), 10.01.2024',
        `- ${hiddenTitle} (Berichte), 01.01.2025`,
        '- Gemeinde › Ablauf: Gemeinde › Fehlt',
        '- Gemeinde › Ablauf: Gemeinde › Geteilt',
        '- Gemeinde › Ablauf: Gemeinde › Neue Seite',
        '- Gemeinde › Ablauf: Gemeinde › Weg',
        '- Gemeinde › Ablauf: Kategorie 9 › seite-x',
        '',
      ].join('\n'),
    );
    expect(result).not.toHaveProperty('provider');
    expect(result).not.toHaveProperty('attempts');
  });

  it('fails without the context of the checks, as a fault of the composition', async () => {
    await expect(
      executeRun(
        prepared(),
        trigger,
        { read: standIn(), policy, log: silent, clock: { now: () => at } },
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      kind: 'failed',
      step: 'input',
      code: 'internal',
      final: true,
    });
  });
});
