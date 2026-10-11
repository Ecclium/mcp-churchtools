// The search for the bound of `limit`, against made-up lists whose bound
// the test sets. It must find the exact bound with few requests, stop
// where no bound can be found, and show a list that cuts down silently.
import { describe, expect, it } from 'vitest';

import { Guard } from '../../scripts/spike/lib/guard.mts';
import {
  boundStarts,
  describeLimitBound,
  findLimitBound,
  maxBisections,
  type LimitAnswer,
} from '../../scripts/spike/lib/listing.mts';

interface List {
  readonly ask: (limit: number) => Promise<LimitAnswer>;
  readonly asked: number[];
}

/**
 * A list that accepts every `limit` up to its bound.
 *
 * @param bound - The largest accepted value, or `Infinity`.
 * @param options - Status for every request, or a cap on the echo.
 * @returns The list and the values it was asked for.
 */
function list(
  bound: number,
  options: { readonly status?: number; readonly echoCap?: number } = {},
): List {
  const asked: number[] = [];
  return {
    asked,
    ask: (limit) => {
      asked.push(limit);
      const status = options.status ?? (limit <= bound ? 200 : 400);
      const echo =
        status === 200 ? Math.min(limit, options.echoCap ?? limit) : undefined;
      return Promise.resolve({ limit, status, echo });
    },
  };
}

const maxRequests = boundStarts.length + maxBisections;

describe('the search for the bound of limit', () => {
  it.each([1, 2, 37, 50, 100, 500, 998, 999])(
    'finds a bound of %i exactly',
    async (bound) => {
      const api = list(bound);
      const found = await findLimitBound(api.ask);
      expect(found.result).toBe('genau');
      expect(found.accepted).toBe(bound);
      expect(found.rejected).toBe(bound + 1);
      expect(api.asked.length).toBeLessThanOrEqual(maxRequests);
    },
  );

  it('says the bound lies above 999 when 1000 is accepted', async () => {
    const api = list(Infinity);
    const found = await findLimitBound(api.ask);
    expect(found.result).toBe('über 999');
    expect(found.accepted).toBe(1000);
    expect(api.asked).toEqual([...boundStarts]);
  });

  it('accepts no value when every request is refused', async () => {
    const found = await findLimitBound(list(0).ask);
    expect(found.result).toBe('keiner angenommen');
    expect(found.accepted).toBeUndefined();
  });

  it('stops without a bound on any other status', async () => {
    const api = list(100, { status: 403 });
    const found = await findLimitBound(api.ask);
    expect(found.result).toBe('nicht bestimmbar');
    expect(api.asked).toEqual([...boundStarts]);
  });

  it('stops when a refused value lies below an accepted one', async () => {
    const api: List = {
      asked: [],
      ask: (limit) =>
        Promise.resolve({
          limit,
          status: limit === 2 ? 400 : 200,
          echo: undefined,
        }),
    };
    const found = await findLimitBound(api.ask);
    expect(found.result).toBe('uneinheitlich');
  });

  it('never sends more than the start values and ten more', async () => {
    let calls = 0;
    // Answers 200 and 400 in turn, so the gap never closes on its own.
    const found = await findLimitBound((limit) => {
      calls += 1;
      const status = limit <= 100 || (calls > 5 && calls % 2 === 0) ? 200 : 400;
      return Promise.resolve({ limit, status, echo: undefined });
    });
    expect(calls).toBeLessThanOrEqual(maxRequests);
    expect(['genau', 'eingegrenzt']).toContain(found.result);
  });

  it('shows a list that cuts the limit down without an error', async () => {
    const guard = new Guard();
    const found = await findLimitBound(list(Infinity, { echoCap: 100 }).ask);
    const description = describeLimitBound(found, guard) as Record<
      string,
      unknown
    >;
    expect(description['ergebnis']).toBe('über 999');
    expect(description['kuerzung']).toBe('ja');
    expect(guard.check(description as never)).toEqual([]);
  });

  it('describes every request with exact numbers the guard lets pass', async () => {
    const guard = new Guard();
    const found = await findLimitBound(list(500).ask);
    const description = describeLimitBound(found, guard) as Record<
      string,
      unknown
    >;
    expect(description).toMatchObject({
      ergebnis: 'genau',
      groesstesAngenommen: 500,
      kleinstesAbgelehnt: 501,
      kuerzung: 'nein',
    });
    expect(description['anfragen']).toEqual(
      found.answers.map((answer) => ({
        angefragt: answer.limit,
        status: answer.status,
        limitEcho: answer.echo ?? 'kein Echo',
      })),
    );
    expect(guard.check(description as never)).toEqual([]);
  });
});
