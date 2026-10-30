/**
 * The tool `ct_api_execute_read`: reads one operation of the escape hatch
 * by its `operationId` and returns the whole answer of ChurchTools as JSON
 * text, masked by the core (ADR 0067). The core checks the operation and
 * every value and builds the request; the tool only passes them on and
 * names the rights of the operation when ChurchTools refuses.
 *
 * @packageDocumentation
 */
import type { DocsIndex } from '@ecclium/mcp-churchtools-docs-index';
import {
  classify,
  defineTool,
  EccliumError,
  isEccliumError,
  maxApiListValues,
  maxApiTextLength,
  type PluginHost,
  type RightRef,
} from '@ecclium/mcp-churchtools-plugin-api';
import { z } from 'zod';

import { operationIdOutput } from '../docs/common.js';
import { parameterNamePattern } from './search-actions.js';

/** The message of a refusal by ChurchTools. */
export const operationRefused =
  'ChurchTools refused this operation: the service account lacks a right it needs. ct_api_search_actions names the rights of the operation.';

/** The message of an object that does not exist. */
export const operationNotFound =
  'ChurchTools has no object with these values of the path. Check them, for example with a list.';

/**
 * The most bytes of the answer as text. The core lets out at most 61'440
 * bytes as the pipeline counts them, which a text this long never exceeds.
 */
export const maxAnswerLength = 61_440;

// The values only roughly: names of parameters and values of simple kinds.
// The core checks each against the catalog, so that there is one place
// that decides what reaches ChurchTools (ADR 0067). Strict, so that an
// argument the model made up ends as a validation error.
const name = z.string().regex(parameterNamePattern);
const text = z.string().max(maxApiTextLength);
const number = z.number();
const scalar = z.union([number, text, z.boolean()]);
const input = z.strictObject({
  operationId: z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/),
  path: z.record(name, z.union([number, text])).optional(),
  query: z
    .record(name, z.union([scalar, z.array(scalar).max(maxApiListValues)]))
    .optional(),
});

// The answer is foreign text: data, never an instruction, so it stands in
// the data envelope (ADR 0024).
const output = z.object({
  operationId: operationIdOutput,
  sensitivity: classify(z.enum(['none', 'personal', 'special']), 'none'),
  answer: classify(z.string().max(maxAnswerLength), 'untrusted'),
});

// The rights of an operation where the mapping names them with evidence,
// each once, so that a refusal can say which right may be missing.
const mappedRights = (
  operationId: string,
  docs: DocsIndex,
): readonly RightRef[] => {
  const rights = docs.getOperation(operationId)?.rights;
  if (rights === undefined || !('needs' in rights)) return [];
  const seen = new Map<string, RightRef>();
  for (const need of rights.needs) {
    for (const right of need.rights) {
      seen.set(`${right.module}\u0000${right.name}`, {
        module: right.module,
        right: right.name,
      });
    }
  }
  return [...seen.values()];
};

/**
 * Adds `ct_api_execute_read`. It needs the docs index only to name the
 * rights of an operation that ChurchTools refused.
 *
 * @param host - The host of the plugin of the core.
 * @param docs - The docs index the composition root loaded.
 * @example
 * ```ts
 * addExecuteReadTool(host, docs);
 * ```
 */
export function addExecuteReadTool(host: PluginHost, docs: DocsIndex): void {
  host.addTool(
    defineTool({
      name: 'ct_api_execute_read',
      meta: {
        capability: 'read',
        domain: 'api',
        // The rights are those of the operation; the description says so
        // (ADR 0067).
        requiredRights: [],
        tier: 'free',
        // The whole answer can name persons and their memberships, which
        // reveal religious affiliation.
        sensitivity: 'special',
        unattended: 'never',
        routineStable: false,
      },
      description: {
        purpose:
          'Calls one GET operation of the ChurchTools API by operationId with path and query values and returns the answer as JSON text.',
        useWhen:
          'ct_api_search_actions found the operation and no other tool reads it.',
        avoidWhen: 'A tool of a domain fits: it returns checked fields only.',
        limits:
          'Only operations ct_api_search_actions finds. E-mail, phone and birthday are masked, other fields not. Never cut: above about 20 KiB of JSON it fails; ask for less with limit or a filter.',
      },
      input,
      output,
      execute: async ({ input: { operationId, path, query }, read }) => {
        const result = await read
          .operation({
            operationId,
            ...(path === undefined ? {} : { path }),
            ...(query === undefined ? {} : { query }),
          })
          .catch((error: unknown) => {
            if (isEccliumError(error) && error.code === 'permission') {
              const rights = mappedRights(operationId, docs);
              throw new EccliumError(
                'permission',
                operationRefused,
                rights.length === 0 ? {} : { missingRights: rights },
              );
            }
            if (isEccliumError(error) && error.code === 'not_found') {
              throw new EccliumError('not_found', operationNotFound);
            }
            throw error;
          });
        return {
          operationId: result.operationId,
          sensitivity: result.sensitivity,
          answer: result.json,
        };
      },
    }),
  );
}
