import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { createChurchTools, createModel } from '../../scripts/e2e/mock.mts';
import { limitsOf, nodeImageOf, squidImageOf } from '../../scripts/e2e/run.mts';
import {
  countCalls,
  faultAnchor,
  faultLine,
  highestPeak,
  judgePeaks,
  judgeProbe,
  oneSectionPerPeriod,
  peakOf,
  type ProbeResult,
  routineId,
  sectionsOf,
  waitBeforeProof,
  withFault,
} from '../../scripts/e2e/verdict.mts';

// The E2E job (scripts/e2e/, ADR 0036) runs only with Docker. These tests
// check without Docker what it decides with: the verdicts, the stand-ins,
// the fault it builds in and the sources of its images and limits. All
// data are made up.

const read = (path: string): string =>
  readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

const line = (
  routine: string,
  period: string,
  code = 'ABCDEFGHIJKLM',
): string =>
  `Automatisch erstellt am 14.11.2026 durch Ecclium, Routine ${routine}, Lauf ${period}, Prüfcode k1:${code}. Rückfragen an Sekretariat.`;

describe('the count of sections', () => {
  const page = [
    'Berichte der Routine.',
    '',
    '- Eintrag 1',
    '',
    line(routineId, '2026-W01'),
    '',
    '- Eintrag 2',
    '',
    line(routineId, '2026-W02'),
    '',
    line('andere-routine', '2026-W01'),
    'Automatisch erstellt am 14.11.2026 durch Ecclium, interaktiv, Prüfcode k1:ABCDEFGHIJKLM. Rückfragen an Sekretariat.',
  ].join('\n');

  it('counts the sections of the routine per period only', () => {
    expect([...sectionsOf(page, routineId)]).toEqual([
      ['2026-W01', 1],
      ['2026-W02', 1],
    ]);
    expect(oneSectionPerPeriod(page, routineId)).toEqual([]);
  });

  it('fails a page with two sections of one period', () => {
    const twice = `${page}\n\n- Eintrag 3\n\n${line(routineId, '2026-W01', 'BCDEFGHIJKLMN')}`;
    expect(oneSectionPerPeriod(twice, routineId)).toEqual([
      'Die Periode 2026-W01 hat 2 Abschnitte statt einem.',
    ]);
  });

  it('fails a page without a section of the routine', () => {
    expect(
      oneSectionPerPeriod('Berichte der Routine.', routineId),
    ).toHaveLength(1);
  });

  it('does not count a line in a code block or with another code form', () => {
    expect(
      sectionsOf(`    ${line(routineId, '2026-W01')}`, routineId).size,
    ).toBe(0);
    expect(
      sectionsOf(line(routineId, '2026-W01').replace('k1:', 'k2:'), routineId)
        .size,
    ).toBe(0);
  });
});

describe('the fault that writes twice', () => {
  it('goes in after the anchor when it stands there once', () => {
    const source = `const a = 1;\n${faultAnchor}\n    return 'real';\n}\n`;
    const changed = withFault(source);
    expect(changed).toEqual({
      ok: true,
      source: `const a = 1;\n${faultAnchor}\n${faultLine}\n    return 'real';\n}\n`,
    });
  });

  it('refuses a source without the anchor or with it twice', () => {
    expect(withFault('const a = 1;\n')).toEqual({ ok: false, found: 0 });
    expect(withFault(`${faultAnchor}\n${faultAnchor}\n`)).toEqual({
      ok: false,
      found: 2,
    });
  });

  it('finds its anchor once in the source of the write guard', () => {
    const source = read('packages/core/src/marker/sections.ts');
    expect(
      source.split('export function judgeSections(options: {').length - 1,
    ).toBe(1);
  });

  // The job builds first; without a build there is nothing to compare. The
  // file is read once, not checked and then read.
  const built = ((): string | undefined => {
    try {
      return readFileSync(
        new URL('../../packages/core/dist/marker/sections.js', import.meta.url),
        'utf8',
      );
    } catch {
      return undefined;
    }
  })();
  it.runIf(built !== undefined)(
    'finds its anchor once in the built write guard',
    () => {
      expect(withFault(built ?? '').ok).toBe(true);
    },
  );
});

describe('the wait before a proof', () => {
  const at = (iso: string): number => Date.parse(iso);
  const window = 10 * 60_000;

  it('does not wait at noon', () => {
    expect(
      waitBeforeProof(at('2026-11-14T11:00:00Z'), window, 'Europe/Zurich'),
    ).toBe(0);
  });

  it('waits past the change of the UTC day', () => {
    const now = at('2026-11-14T23:55:00Z');
    const wait = waitBeforeProof(now, window, 'Europe/Zurich');
    expect(wait).toBeGreaterThan(0);
    expect(waitBeforeProof(now + wait, window, 'Europe/Zurich')).toBe(0);
  });

  it('waits past the change of the day in the time zone', () => {
    // Midnight in Zurich is 23:00 UTC in winter.
    const now = at('2026-11-14T22:55:00Z');
    const wait = waitBeforeProof(now, window, 'Europe/Zurich');
    expect(wait).toBeGreaterThan(0);
    expect(waitBeforeProof(now + wait, window, 'Europe/Zurich')).toBe(0);
  });
});

describe('the verdict on the probe of the network', () => {
  const allowed = ['churchtools.e2e.test:443', 'model.e2e.test:443'];
  const refused = ['decoy.e2e.test:443'];
  const good: ProbeResult = {
    decoyName: { result: 'failed', code: 'EAI_AGAIN' },
    decoyAddress: { result: 'failed', code: 'ENETUNREACH' },
    proxy: { result: 'ok' },
    connect: {
      'churchtools.e2e.test:443': 200,
      'model.e2e.test:443': 200,
      'decoy.e2e.test:443': 403,
    },
    tls: {
      'churchtools.e2e.test:443': { result: 'ok' },
      'model.e2e.test:443': { result: 'ok' },
    },
    plainGet: 403,
  };

  it('passes a network with the proxy as the one way out', () => {
    expect(judgeProbe(good, allowed, refused)).toEqual([]);
  });

  it.each([
    [
      'a name of the decoy that resolves',
      { ...good, decoyName: { result: 'ok' } },
    ],
    ['a direct way to the decoy', { ...good, decoyAddress: { result: 'ok' } }],
    ['a proxy out of reach', { ...good, proxy: { result: 'timeout' } }],
    [
      'a tunnel to the decoy',
      { ...good, connect: { ...good.connect, 'decoy.e2e.test:443': 200 } },
    ],
    [
      'no tunnel to ChurchTools',
      {
        ...good,
        connect: { ...good.connect, 'churchtools.e2e.test:443': 403 },
      },
    ],
    [
      'no TLS through the tunnel to the model',
      {
        ...good,
        tls: {
          ...good.tls,
          'model.e2e.test:443': {
            result: 'failed',
            code: 'ERR_TLS_CERT_ALTNAME_INVALID',
          },
        },
      },
    ],
    ['a plain GET through the proxy', { ...good, plainGet: 200 }],
  ] as const)('fails %s', (_name, probe) => {
    expect(judgeProbe(probe as ProbeResult, allowed, refused)).toHaveLength(1);
  });
});

describe('the peaks of a run', () => {
  it('reads the last line of the wrapper', () => {
    expect(peakOf('{"result":"written"}\n\ne2e-peak 81190912 13\n')).toEqual({
      memory: 81190912,
      pids: 13,
    });
    expect(peakOf('e2e-peak 1000 -\n')).toEqual({ memory: 1000 });
    expect(peakOf('{"result":"written"}\n')).toBeUndefined();
  });

  it('judges the peaks against the limits', () => {
    const limits = { memory: 256 * 1024 * 1024, pids: 32 };
    const peaks = [
      { memory: 80_000_000, pids: 13 },
      { memory: 50_000_000, pids: 12 },
    ];
    expect(judgePeaks(peaks, limits)).toEqual([]);
    expect(highestPeak(peaks)).toEqual({ memory: 80_000_000, pids: 13 });
    expect(
      judgePeaks([{ memory: limits.memory, pids: 32 }], limits),
    ).toHaveLength(2);
  });

  it('passes a kernel that gives no count of processes for any run', () => {
    const limits = { memory: 256 * 1024 * 1024, pids: 32 };
    expect(
      judgePeaks([{ memory: 80_000_000 }, { memory: 50_000_000 }], limits),
    ).toEqual([]);
  });

  it.each([
    ['no measured run', []],
    ['a run without a line of peaks', [{ memory: 1, pids: 1 }, undefined]],
    ['a run without its memory', [{ memory: 1, pids: 1 }, { pids: 1 }]],
    [
      'a count of processes for only some runs',
      [{ memory: 1, pids: 1 }, { memory: 1 }],
    ],
  ] as const)('fails %s', (_name, peaks) => {
    expect(
      judgePeaks(peaks, { memory: 256 * 1024 * 1024, pids: 32 }),
    ).not.toEqual([]);
  });
});

describe('the stand-in of ChurchTools', () => {
  const guid = '00000000-0000-4000-8000-000000000001';
  const config = {
    accounts: [
      { token: 'e2e-token-a', id: 1, rights: { churchwiki: { view: true } } },
    ],
    category: { id: 7, name: 'Berichte' },
    page: { guid, title: 'Wochenbericht', text: 'Berichte der Routine.' },
  };
  const ask = (
    standIn: ReturnType<typeof createChurchTools>,
    method: string,
    path: string,
    body = '',
    token = 'e2e-token-a',
  ) =>
    standIn.respond({
      method,
      url: new URL(path, 'https://mock.invalid'),
      authorization: `Login ${token}`,
      body,
    });
  const page = `/api/wiki/categories/7/pages/${guid}`;

  it('answers only a known token', () => {
    const standIn = createChurchTools(config);
    expect(ask(standIn, 'GET', '/api/whoami', '', 'other').status).toBe(401);
    expect(ask(standIn, 'GET', '/api/permissions/global')).toEqual({
      status: 200,
      body: { data: { churchwiki: { view: true } } },
    });
  });

  it('lists the page only for its category', () => {
    const standIn = createChurchTools(config);
    const listed = ask(standIn, 'GET', '/api/wiki/pages?wiki_category_ids[]=7');
    expect((listed.body as { data: unknown[] }).data).toHaveLength(1);
    const other = ask(standIn, 'GET', '/api/wiki/pages?wiki_category_ids[]=8');
    expect((other.body as { data: unknown[] }).data).toHaveLength(0);
  });

  it('keeps a new text with a new version, trimmed, and an equal one without', () => {
    const standIn = createChurchTools(config);
    expect(
      ask(standIn, 'PATCH', page, JSON.stringify({ text: '  Neu.\n\n' }))
        .status,
    ).toBe(200);
    expect(standIn.page()).toEqual({ version: 2, text: 'Neu.' });
    ask(standIn, 'PATCH', page, JSON.stringify({ text: 'Neu.' }));
    expect(standIn.page()).toEqual({ version: 2, text: 'Neu.' });
    const read = ask(standIn, 'GET', page);
    expect((read.body as { data: { version: number } }).data.version).toBe(2);
  });

  it('refuses another page, another category and a body without text', () => {
    const standIn = createChurchTools(config);
    expect(
      ask(standIn, 'GET', `/api/wiki/categories/8/pages/${guid}`).status,
    ).toBe(404);
    expect(
      ask(
        standIn,
        'GET',
        '/api/wiki/categories/7/pages/00000000-0000-4000-8000-000000000002',
      ).status,
    ).toBe(404);
    expect(ask(standIn, 'PATCH', page, '{}').status).toBe(400);
    expect(ask(standIn, 'PATCH', page, 'kein JSON').status).toBe(400);
  });
});

describe('the stand-in of the model', () => {
  const config = { key: 'e2e-key', block: 'punkte', field: 'text' };
  const call = (model: ReturnType<typeof createModel>, key = 'e2e-key') =>
    model({
      method: 'POST',
      url: new URL('/v1/chat/completions', 'https://mock.invalid'),
      authorization: `Bearer ${key}`,
      body: '{}',
    });

  it('answers each call with another numbered block', () => {
    const model = createModel(config);
    const contentOf = (answer: ReturnType<typeof call>): unknown =>
      JSON.parse(
        (answer.body as { choices: [{ message: { content: string } }] })
          .choices[0].message.content,
      );
    expect(contentOf(call(model))).toEqual({ punkte: [{ text: 'Eintrag 1' }] });
    expect(contentOf(call(model))).toEqual({ punkte: [{ text: 'Eintrag 2' }] });
  });

  it('refuses another key', () => {
    expect(call(createModel(config), 'other').status).toBe(401);
  });
});

describe('the sources of the job', () => {
  it('takes the image of Node.js from compose.yaml, pinned by digest', () => {
    expect(nodeImageOf(read('scripts/e2e/compose.yaml'))).toMatch(
      /^node:24-trixie-slim@sha256:[0-9a-f]{64}$/,
    );
  });

  it('takes the image of Squid from the header of the template', () => {
    expect(squidImageOf(read('deploy/selfhost/egress/squid.conf'))).toMatch(
      /^ubuntu\/squid:\S+@sha256:[0-9a-f]{64}$/,
    );
  });

  it('takes the limits of the runner from compose.yaml', () => {
    expect(limitsOf(read('scripts/e2e/compose.yaml'))).toEqual({
      memory: 256 * 1024 * 1024,
      pids: 32,
    });
  });

  it('counts the requests of a method below a path', () => {
    const calls = [
      { method: 'PATCH', path: '/api/wiki/categories/7/pages/x', status: 200 },
      { method: 'GET', path: '/api/wiki/categories/7/pages/x', status: 200 },
      { method: 'PATCH', path: '/api/other', status: 404 },
    ];
    expect(countCalls(calls, 'PATCH', '/api/wiki/')).toBe(1);
  });
});
