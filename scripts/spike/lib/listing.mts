/**
 * Helpers for the probes that read lists.
 *
 * They read the number of entries and the pagination of a list response,
 * and they hold the values of `limit` and `page` the probes send. A probe
 * prints the number of entries exactly only where its question needs it.
 *
 * @packageDocumentation
 */
import type { Guard, Json } from './guard.mts';
import { isObject, type JsonObject } from './spec.mts';

/** The values of `limit` a probe sends with the first page. */
export const limits = [1, 2, 100, 1000] as const;

/** Invalid values for `page` and `limit`, each sent once. */
export const invalidValues = [
  ['page', '0'],
  ['page', '-1'],
  ['page', 'x'],
  ['limit', '0'],
  ['limit', '-1'],
  ['limit', 'x'],
] as const;

/**
 * Counts the entries of a list response.
 *
 * @param body - Parsed body of a response.
 * @returns The number of entries in `data`, or `undefined` if `data` is no list.
 */
export function entries(body: unknown): number | undefined {
  const data = isObject(body) ? body['data'] : undefined;
  return Array.isArray(data) ? data.length : undefined;
}

/**
 * Reads `meta.pagination` of a list response.
 *
 * @param body - Parsed body of a response.
 * @returns The pagination object, or `undefined` if there is none.
 */
export function pagination(body: unknown): JsonObject | undefined {
  const meta = isObject(body) ? body['meta'] : undefined;
  const value = isObject(meta) ? meta['pagination'] : undefined;
  return isObject(value) ? value : undefined;
}

/** The values of `limit` the search for the bound starts with. */
export const boundStarts = [1, 2, 50, 100, 1000] as const;

/** At most this many further requests narrow the bound down. */
export const maxBisections = 10;

/** What one request with a value of `limit` returned. */
export interface LimitAnswer {
  readonly limit: number;
  readonly status: number;
  /** `meta.pagination.limit` of the answer, if it has one. */
  readonly echo: number | undefined;
}

/** How the search for the bound of `limit` ended. */
export type BoundResult =
  | 'genau'
  | 'eingegrenzt'
  | 'über 999'
  | 'keiner angenommen'
  | 'uneinheitlich'
  | 'nicht bestimmbar';

/** What the search for the bound of `limit` found. */
export interface LimitBound {
  /** Every answer, the start values first, in the order they were asked. */
  readonly answers: readonly LimitAnswer[];
  /** The largest value answered with 200, if any. */
  readonly accepted: number | undefined;
  /** The smallest value above it answered with 400, if any. */
  readonly rejected: number | undefined;
  readonly result: BoundResult;
}

/**
 * Searches the largest value of `limit` a list accepts.
 *
 * It sends the start values, then halves the gap between the largest
 * value answered with 200 and the smallest larger value answered with 400,
 * at most {@link maxBisections} times. Any other status ends the search:
 * without the right to read the list, for example, there is no bound to
 * find. If 1000 is accepted too, the bound lies above 999 and is not
 * searched further.
 *
 * @param ask - Sends one request with the given `limit`.
 * @returns The answers and the bound.
 */
export async function findLimitBound(
  ask: (limit: number) => Promise<LimitAnswer>,
): Promise<LimitBound> {
  const answers: LimitAnswer[] = [];
  for (const limit of boundStarts) {
    answers.push(await ask(limit));
  }
  const done = (
    result: BoundResult,
    accepted?: number,
    rejected?: number,
  ): LimitBound => ({ answers, accepted, rejected, result });
  if (
    answers.some((answer) => answer.status !== 200 && answer.status !== 400)
  ) {
    return done('nicht bestimmbar');
  }
  const ok = answers.filter((answer) => answer.status === 200);
  if (ok.length === 0) {
    return done('keiner angenommen');
  }
  let accepted = Math.max(...ok.map((answer) => answer.limit));
  const above = answers.filter(
    (answer) => answer.status === 400 && answer.limit > accepted,
  );
  if (
    answers.some((answer) => answer.status === 400 && answer.limit < accepted)
  ) {
    return done('uneinheitlich', accepted);
  }
  if (above.length === 0) {
    return done('über 999', accepted);
  }
  let rejected = Math.min(...above.map((answer) => answer.limit));
  for (let step = 0; step < maxBisections && rejected - accepted > 1; step++) {
    const middle = Math.floor((accepted + rejected) / 2);
    const answer = await ask(middle);
    answers.push(answer);
    if (answer.status === 200) {
      accepted = middle;
    } else if (answer.status === 400) {
      rejected = middle;
    } else {
      return done('nicht bestimmbar', accepted, rejected);
    }
  }
  return done(
    rejected - accepted === 1 ? 'genau' : 'eingegrenzt',
    accepted,
    rejected,
  );
}

/** Words a description of a bound may contain. */
export const boundWords = [
  'ergebnis',
  'genau',
  'eingegrenzt',
  'über 999',
  'keiner angenommen',
  'uneinheitlich',
  'nicht bestimmbar',
  'groesstesAngenommen',
  'kleinstesAbgelehnt',
  'keiner',
  'kuerzung',
  'ja',
  'nein',
  'kein Echo',
  'anfragen',
  'angefragt',
  'status',
  'limitEcho',
] as const;

/**
 * Describes a bound for the output. The values of `limit`, the statuses
 * and the echoes appear exactly: they are properties of the API, not of
 * the data.
 *
 * `kuerzung` says whether an accepted value came back smaller in the echo,
 * a sign that the instance cuts the list down without an error.
 *
 * @param bound - What {@link findLimitBound} found.
 * @param guard - The guard of the run.
 * @returns The description.
 */
export function describeLimitBound(bound: LimitBound, guard: Guard): Json {
  guard.allowFixed(...boundWords);
  const accepted = bound.answers.filter((answer) => answer.status === 200);
  const kuerzung = accepted.some(
    (answer) => answer.echo !== undefined && answer.echo < answer.limit,
  )
    ? 'ja'
    : accepted.some((answer) => answer.echo !== undefined)
      ? 'nein'
      : 'kein Echo';
  return {
    ergebnis: bound.result,
    groesstesAngenommen: exact(guard, bound.accepted, 'keiner'),
    kleinstesAbgelehnt: exact(guard, bound.rejected, 'keiner'),
    kuerzung,
    anfragen: bound.answers.map((answer) => ({
      angefragt: exact(guard, answer.limit, 'keiner'),
      status: exact(guard, answer.status, 'keiner'),
      limitEcho: exact(guard, answer.echo, 'kein Echo'),
    })),
  };
}

/**
 * Lets one exact number into the output.
 *
 * Exact numbers are allowed only on purpose, where the question is how
 * many entries come back or what the instance reports as its limit.
 *
 * @param guard - The guard of the run, which learns the number as a fixed word.
 * @param value - The number, or `undefined` if the response has none.
 * @param missing - The fixed word to print instead of a missing number.
 * @returns The number, or the fixed word.
 */
export function exact(
  guard: Guard,
  value: number | undefined,
  missing: string,
): Json {
  if (value === undefined) {
    return missing;
  }
  guard.allowFixed(value);
  return value;
}
