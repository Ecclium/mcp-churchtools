/**
 * The tool `ct_api_search_actions`: searches the operations of the API
 * that the escape hatch reads, in the facts of the OpenAPI document, and
 * gives each with the parameters `ct_api_execute_read` takes and the
 * rights the project mapped to it with evidence (ADR 0067). It asks
 * ChurchTools nothing: the list of operations comes from the core, the
 * texts and rights from the docs index.
 *
 * @packageDocumentation
 */
import type { DocsIndex } from '@ecclium/mcp-churchtools-docs-index';
import {
  type ApiOperation,
  type ApiParameter,
  classify,
  defineTool,
  maxApiListValues,
  type PluginHost,
} from '@ecclium/mcp-churchtools-plugin-api';
import { z } from 'zod';

import {
  maxDocsQueryLength,
  openApiSource,
  openApiSourceOutput,
  operationIdOutput,
  pathOutput,
} from '../docs/common.js';
import { rightsOf, rightsOutput } from '../docs/operations.js';

/** The most hits of one search: each comes with parameters and rights. */
export const maxActionHits = 10;

/** The hits of a search without a limit. */
export const defaultActionHits = 5;

/**
 * The name of a parameter as the core lists it, such as `groupId` or
 * `include[]`, outside the data envelope.
 */
export const parameterNamePattern = /^[A-Za-z][A-Za-z0-9_.[\]-]{0,63}$/;

// The words of a search, as for the docs tools: not blank and without
// control characters.
const input = z.strictObject({
  query: classify(
    z
      .string()
      .min(1)
      .max(maxDocsQueryLength)
      .regex(/\S/u)
      .regex(/^\P{Cc}*$/u),
    'none',
  ),
  limit: classify(
    z.number().int().min(1).max(maxActionHits),
    'none',
  ).optional(),
});

const sensitivityOutput = classify(
  z.enum(['none', 'personal', 'special']),
  'none',
);

// A parameter as ct_api_execute_read takes it. Names and fixed values come
// from the catalog of the core, printable ASCII without spaces, so they
// stand outside the envelope.
const parameterOutput = z.object({
  name: classify(z.string().regex(parameterNamePattern), 'none'),
  kind: classify(
    z.enum([
      'integer',
      'number',
      'boolean',
      'string',
      'date',
      'date-time',
      'date-or-date-time',
      'enum',
      'guid',
    ]),
    'none',
  ),
  required: classify(z.boolean(), 'none'),
  list: classify(z.boolean(), 'none'),
  values: z
    .array(classify(z.string().regex(/^[\x21-\x7e]{1,64}$/), 'none'))
    .max(maxApiListValues),
});

const output = z.object({
  hits: z
    .array(
      z.object({
        operationId: operationIdOutput,
        path: pathOutput,
        summary: classify(z.string().max(1000), 'untrusted').nullable(),
        sensitivity: sensitivityOutput,
        pathParameters: z.array(parameterOutput).max(10),
        queryParameters: z.array(parameterOutput).max(50),
        rights: rightsOutput,
      }),
    )
    .max(maxActionHits),
  more: classify(z.boolean(), 'none'),
  source: openApiSourceOutput,
});

type Output = z.input<typeof output>;

const parameterOf = ({
  name,
  kind,
  required,
  list,
  values,
}: ApiParameter): Output['hits'][number]['pathParameters'][number] => ({
  name,
  kind,
  required,
  list,
  values: values === undefined ? [] : [...values],
});

/**
 * Adds `ct_api_search_actions`, which searches over the docs index the
 * composition root loaded.
 *
 * @param host - The host of the plugin of the core.
 * @param docs - The docs index.
 * @example
 * ```ts
 * addSearchActionsTool(host, docs);
 * ```
 */
export function addSearchActionsTool(host: PluginHost, docs: DocsIndex): void {
  host.addTool(
    defineTool({
      name: 'ct_api_search_actions',
      meta: {
        capability: 'read',
        domain: 'api',
        requiredRights: [],
        tier: 'free',
        sensitivity: 'none',
        unattended: 'policy',
        routineStable: false,
      },
      description: {
        purpose:
          'Searches the ChurchTools API operations that ct_api_execute_read may call; returns operationId, path, parameters, sensitivity and the rights each needs, with evidence.',
        useWhen:
          'No other tool reads what you need: find the operation and its parameters first.',
        avoidWhen: 'A tool of a domain covers it.',
        limits:
          'GET only. Words match the English texts of the document. At most 10 hits. Rights stand only where mapped with evidence.',
      },
      input,
      output,
      execute: async ({
        input: { query, limit = defaultActionHits },
        read,
      }) => {
        // The core decides what the escape hatch reads; the index only
        // ranks among those and adds texts and rights.
        const readable = new Map<string, ApiOperation>(
          (await read.operations()).map((operation) => [
            operation.operationId,
            operation,
          ]),
        );
        const found = docs.searchOperations(
          query.trim(),
          limit + 1,
          new Set(readable.keys()),
        );
        const hits = found.slice(0, limit).flatMap((hit) => {
          const operation = readable.get(hit.operationId);
          if (operation === undefined) return [];
          return [
            {
              operationId: operation.operationId,
              path: operation.path,
              summary: hit.summary ?? null,
              sensitivity: operation.sensitivity,
              pathParameters: operation.pathParameters.map(parameterOf),
              queryParameters: operation.queryParameters.map(parameterOf),
              rights: rightsOf(
                docs.getOperation(hit.operationId)?.rights,
                docs,
              ),
            },
          ];
        });
        return {
          hits,
          more: found.length > limit,
          source: openApiSource(docs.sources),
        };
      },
    }),
  );
}
