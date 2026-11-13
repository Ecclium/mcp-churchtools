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
  hiddenGuid,
  hiddenTitle,
  mainPageName,
  maxBlockBytes,
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

  it('take brackets that pair up, an ampersand of HTML and a sign that ends a sentence', () => {
    expect(
      wikiLinksIn(
        [
          `[${origin}/wiki/3/Ablauf%20(Sonntag)](${origin}/wiki/3/Ablauf%20(Sonntag))`,
          '<a href="/wiki/3/Kaffee%20&amp;%20Kuchen">k</a>',
          `Siehe ${origin}/wiki/3/Ablauf. Und /wiki/3/Taufe, dann.`,
          "[a](/wiki/3/Gottes'Wort)",
        ].join('\n'),
        origin,
      ),
    ).toEqual([
      { categoryId: 3, page: 'Ablauf (Sonntag)' },
      { categoryId: 3, page: 'Kaffee & Kuchen' },
      { categoryId: 3, page: 'Ablauf.', trimmed: 'Ablauf' },
      { categoryId: 3, page: 'Taufe,', trimmed: 'Taufe' },
      { categoryId: 3, page: "Gottes'Wort" },
    ]);
  });

  it('take the host without regard to case or without the scheme, never inside another address', () => {
    expect(
      wikiLinksIn(
        [
          '[a](HTTPS://EXAMPLE.Church.tools/wiki/3/A)',
          '[b](//example.church.tools/wiki/3/B)',
          '[c](http://example.church.tools/wiki/3/C)',
          `[d](https://other.example/r/${origin}/wiki/3/D)`,
          '[e](https://other.example/?next=/wiki/3/E)',
          '[f](/wiki/3/Sitemap) [g](/wiki/3/SITEMAP)',
        ].join('\n'),
        origin,
      ),
    ).toEqual([
      { categoryId: 3, page: 'A' },
      { categoryId: 3, page: 'B' },
    ]);
  });

  it('read the text the editor of ChurchTools stored for a typed link', () => {
    // A typed [Text](address) stays text with escaped brackets, and the
    // address in it becomes a link to itself (F55).
    const stored = [
      `\\[Wiki-Pflege]\\([${origin}/wiki/17/Wiki-Pflege](${origin}/wiki/17/Wiki-Pflege))`,
      `\\[Lange Seite]\\([${origin}/wiki/14/Seedprobe%20lange%20Seite](${origin}/wiki/14/Seedprobe%20lange%20Seite))`,
    ].join('\n\n');
    expect(wikiLinksIn(stored, origin)).toEqual([
      { categoryId: 17, page: 'Wiki-Pflege' },
      { categoryId: 14, page: 'Seedprobe lange Seite' },
    ]);
  });

  it('take little time for a long hostile text', () => {
    const hostile = `(/wiki/1/${'('.repeat(200_000)}a ${'%'.repeat(200_000)} /wiki/${'1'.repeat(200_000)}`;
    const started = performance.now();
    wikiLinksIn(hostile, origin);
    expect(performance.now() - started).toBeLessThan(2_000);
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

  it('cut a value longer than its field with three dots, between code points', async () => {
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
    expect(page).toBe(`${'𝄞'.repeat(252)}...`);
  });

  it('check every value again as the report holds it, and give a GUID its own fixed text', async () => {
    const tricky = {
      1: [
        {
          guid: 'seite-trick',
          title: 'Trick',
          modifiedDate: '2026-11-01T08:00:00Z',
          parts: [
            [
              // A category the account does not see, whose number reads
              // as an AHV number once it stands in the report.
              '[x](/wiki/7561234567897/x)',
              // A GUID whose parts read as a phone number.
              '[y](/wiki/1/3F2A9C1E-0123-4567-89AB-CDEF01234567)',
              // A title that ends in a web address once it is cut.
              `[z](/wiki/1/${'A'.repeat(231)}%20kirche.dexyz12)`,
            ].join('\n'),
          ],
        },
      ],
    };
    const checked = await run([links], standIn(tricky));
    if (!checked.ok) throw new Error(checked.code);
    expect(checked.blocks['brokenLinks']).toEqual([
      { page: 'Gemeinde › Trick', link: hiddenTitle },
      { page: 'Gemeinde › Trick', link: hiddenTitle },
      { page: 'Gemeinde › Trick', link: `Gemeinde › ${hiddenGuid}` },
    ]);
  });

  it('read every part of a page from the version of its first part', async () => {
    const calls: { tool: string; input: unknown }[] = [];
    await run([links], standIn(wiki, calls));
    expect(
      calls
        .filter((call) => call.tool === 'ct_wiki_page_get')
        .map((call) => call.input),
    ).toContainEqual({
      categoryId: 1,
      guid: 'seite-ablauf',
      part: 2,
      version: 2,
    });
  });

  it('keep a block within its bytes, in its order', async () => {
    const many = {
      1: Array.from({ length: 100 }, (_, index) => ({
        guid: `seite-${String(index).padStart(3, '0')}`,
        // 255 signs of four bytes each, about 1 KB per entry.
        title: `${String(index).padStart(3, '0')}${'𝄞'.repeat(252)}`,
        modifiedDate: '2020-01-01T08:00:00Z',
        parts: [''],
      })),
    };
    const checked = await run([{ ...stale, maxItems: 100 }], standIn(many));
    if (!checked.ok) throw new Error(checked.code);
    const kept = checked.blocks['stalePages'] ?? [];
    expect(kept.length).toBeGreaterThan(10);
    expect(kept.length).toBeLessThan(100);
    const bytes = kept
      .flatMap((entry) => Object.values(entry))
      .reduce((sum, value) => sum + new TextEncoder().encode(value).length, 0);
    expect(bytes).toBeLessThanOrEqual(maxBlockBytes);
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

  it('gives an entry the fixed text when its line of the template breaks the content policy', async () => {
    // A title that ends in «mailto» before the colon of the template reads
    // as a web address in that line, though each value passes on its own.
    const mail = {
      1: [
        {
          guid: 'seite-mail',
          title: 'Kontakt mailto',
          modifiedDate: '2026-11-01T08:00:00Z',
          parts: ['[x](/wiki/1/Fehlt)'],
        },
      ],
    };
    const result = await executeRun(
      prepared(),
      trigger,
      {
        read: standIn(mail),
        checks: context,
        policy,
        log: silent,
        clock: { now: () => at },
      },
      new AbortController().signal,
    );
    if (result.kind !== 'rendered') throw new Error(result.code);
    expect(result.section).toContain(`- ${hiddenTitle}: ${hiddenTitle}`);
    expect(result.section).not.toContain('mailto');
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
