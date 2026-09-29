/**
 * Probe 00: version and documented operations of the instance.
 *
 * Reads: `GET /system/runtime/swagger/openapi.json` (the OpenAPI document of
 * the instance) and `GET /api/info`.
 * Writes: the state file, once, with the version and the OpenAPI document
 * for the other probes. Nothing in ChurchTools.
 * Answers: the ChurchTools version as major and minor number, and for each
 * operation of the spike whether the instance documents it. It lists no
 * other paths, because the list of paths would show which modules are
 * active. Of the info answer it shows only the status and the version: that
 * answer carries the name and settings of the instance, and no question of
 * the spike needs its structure.
 *
 * Usage: see README.md in this folder.
 *
 * @packageDocumentation
 */
import { SpikeError } from './lib/errors.mts';
import { createState, instanceId } from './lib/env.mts';
import type { Json } from './lib/guard.mts';
import { operations, specificationPath } from './lib/operations.mts';
import { main, type ProbeDefinition } from './lib/probe.mts';
import { asOpenApi, findOperation, isObject } from './lib/spec.mts';

const words = [
  'probe',
  '00-inventory',
  'churchtoolsVersion',
  'unbekannt',
  'spezifikation',
  'status',
  'format',
  'OpenAPI 3',
  'Swagger 2',
  'info',
  'operationen',
  'dokumentiert',
  'nicht dokumentiert',
  'state',
  'angelegt',
  ...Object.keys(operations),
];

/**
 * Takes major and minor number from the version the instance reports.
 *
 * @param body - Parsed body of `GET /api/info`.
 * @returns The version as `major.minor`, or `null` if none is found.
 * @example
 * ```ts
 * versionOf({ version: '3.136.2' }); // '3.136'
 * ```
 */
export function versionOf(body: unknown): string | null {
  const candidates = isObject(body)
    ? [
        body['version'],
        isObject(body['data']) ? body['data']['version'] : undefined,
      ]
    : [];
  for (const candidate of candidates) {
    const match =
      typeof candidate === 'string'
        ? /^(\d{1,3})\.(\d{1,4})(?:\.|$)/.exec(candidate)
        : null;
    if (match !== null) {
      return `${match[1] ?? ''}.${match[2] ?? ''}`;
    }
  }
  return null;
}

/** The probe, for tests and for {@link main}. */
export const probe: ProbeDefinition = {
  name: '00-inventory',
  state: 'create',
  async run({ client, guard, origin, statePath }): Promise<Json> {
    guard.allowFixed(...words);
    // The OpenAPI document describes the API of every instance of the same
    // version; its words are needed as keys, so they stay off the block list.
    const specification = await client.get({
      path: specificationPath,
      maxBytes: 32 * 1024 * 1024,
      blockValues: false,
    });
    const document =
      specification.status === 200 ? asOpenApi(specification.body) : undefined;
    if (document === undefined) {
      throw new SpikeError('ANTWORT_UNGUELTIG', 'spezifikationUngueltig');
    }
    guard.allowFixed(specification.status);
    // The keys of the info answer are not shown: a key of that answer can
    // contain something on the block list, such as a part of the host or the
    // name of the instance, and the guard would then withhold the whole
    // inventory. Its values still go onto the block list. Today nothing of
    // the answer reaches the output, so that is only a precaution in case a
    // later change shows more of it.
    const info = await client.get({ path: operations.info.template });
    guard.allowFixed(info.status);
    const version = versionOf(info.body);
    if (version !== null) {
      guard.allowVersion(version);
    }
    createState(statePath, {
      format: 'ecclium-spike-state.v1',
      instance: instanceId(origin),
      version,
      specification: document,
    });
    return {
      probe: '00-inventory',
      churchtoolsVersion: version ?? 'unbekannt',
      spezifikation: {
        status: specification.status,
        format:
          typeof document['openapi'] === 'string' ? 'OpenAPI 3' : 'Swagger 2',
      },
      info: { status: info.status },
      operationen: Object.fromEntries(
        Object.entries(operations).map(([name, { method, template }]) => [
          name,
          findOperation(document, method, template) === undefined
            ? 'nicht dokumentiert'
            : 'dokumentiert',
        ]),
      ),
      state: 'angelegt',
    };
  },
};

if (import.meta.main) {
  process.exitCode = await main(probe, import.meta.url);
}
