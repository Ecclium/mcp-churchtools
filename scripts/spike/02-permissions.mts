/**
 * Probe 02: the global rights of the service account.
 *
 * Reads: `GET /api/permissions/global`.
 * Writes: nothing.
 * Answers: the structure of the rights response, and the extent of the
 * rights as truth values and counts. Module and right names appear only if
 * they consist of lower-case words, because the specification does not
 * list them. Every other key, such as a category ID, appears as `<key#n>`.
 *
 * Usage: see README.md in this folder.
 *
 * @packageDocumentation
 */
import type { Json } from './lib/guard.mts';
import { operations } from './lib/operations.mts';
import { main, type ProbeDefinition } from './lib/probe.mts';
import { describeResponse } from './lib/report.mts';
import { Schemas, findOperation } from './lib/spec.mts';

/** The probe, for tests and for {@link main}. */
export const probe: ProbeDefinition = {
  name: '02-permissions',
  state: 'read',
  async run({ client, guard, state }): Promise<Json> {
    guard.allowFixed(
      'probe',
      '02-permissions',
      'permissionsGlobal',
      'nicht dokumentiert',
      'antwort',
    );
    if (state === undefined) {
      throw new Error('INTERN');
    }
    const document = state.specification;
    const { method, template } = operations.permissionsGlobal;
    const operation = findOperation(document, method, template);
    if (operation === undefined) {
      return {
        probe: '02-permissions',
        permissionsGlobal: 'nicht dokumentiert',
      };
    }
    const response = await client.get({ path: template });
    return {
      probe: '02-permissions',
      antwort: describeResponse(response, {
        guard,
        schemas: new Schemas(document),
        operation,
        keys: 'lowercaseWords',
        booleanValues: true,
      }),
    };
  },
};

if (import.meta.main) {
  process.exitCode = await main(probe, import.meta.url);
}
