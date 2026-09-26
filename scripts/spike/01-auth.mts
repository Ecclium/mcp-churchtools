/**
 * Probe 01: authentication and the structure of `whoami`.
 *
 * Reads: `GET /api/whoami` six times: with the token, without a token and
 * with an invalid token made up at run time, each with and without the
 * parameter `only_allow_authenticated=true`.
 * Writes: nothing.
 * Answers: whether the token is accepted, the structure of `whoami`, the
 * format of a 401 response, what an unauthenticated request receives, and
 * whether a response sets a cookie, which would mean a session.
 *
 * Usage: see README.md in this folder.
 *
 * @packageDocumentation
 */
import { randomBytes } from 'node:crypto';

import type { Json } from './lib/guard.mts';
import type { Authorization } from './lib/http.mts';
import { operations } from './lib/operations.mts';
import { main, type ProbeDefinition } from './lib/probe.mts';
import { describeResponse } from './lib/report.mts';
import { Schemas, findOperation } from './lib/spec.mts';

const onlyAuthenticated = 'only_allow_authenticated';

/** The probe, for tests and for {@link main}. */
export const probe: ProbeDefinition = {
  name: '01-auth',
  state: 'read',
  async run({ client, guard, state }): Promise<Json> {
    guard.allowFixed(
      'probe',
      '01-auth',
      'whoami',
      'nicht dokumentiert',
      'parameterDokumentiert',
      onlyAuthenticated,
      'ja',
      'nein',
      'anfragen',
      'mitToken',
      'mitTokenNurAngemeldet',
      'ohneToken',
      'ohneTokenNurAngemeldet',
      'falschesToken',
      'falschesTokenNurAngemeldet',
    );
    if (state === undefined) {
      throw new Error('INTERN');
    }
    const document = state.specification;
    const schemas = new Schemas(document);
    const { method, template } = operations.whoami;
    const operation = findOperation(document, method, template);
    if (operation === undefined) {
      return { probe: '01-auth', whoami: 'nicht dokumentiert' };
    }
    // A random value that no instance can accept, never printed.
    const invalidToken = randomBytes(24).toString('hex');
    guard.block(invalidToken);
    const variants: readonly (readonly [string, Authorization, boolean])[] = [
      ['mitToken', 'token', false],
      ['mitTokenNurAngemeldet', 'token', true],
      ['ohneToken', 'ohne', false],
      ['ohneTokenNurAngemeldet', 'ohne', true],
      ['falschesToken', { invalidToken }, false],
      ['falschesTokenNurAngemeldet', { invalidToken }, true],
    ];
    const results: Record<string, Json> = {};
    for (const [label, auth, restricted] of variants) {
      const response = await client.get({
        path: template,
        auth,
        query: restricted ? [[onlyAuthenticated, 'true']] : [],
      });
      results[label] = describeResponse(response, {
        guard,
        schemas,
        operation,
      });
    }
    return {
      probe: '01-auth',
      parameterDokumentiert: {
        [onlyAuthenticated]: schemas
          .queryParameters(operation)
          .has(onlyAuthenticated)
          ? 'ja'
          : 'nein',
      },
      anfragen: results,
    };
  },
};

if (import.meta.main) {
  process.exitCode = await main(probe, import.meta.url);
}
