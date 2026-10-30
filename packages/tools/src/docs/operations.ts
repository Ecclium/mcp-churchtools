/**
 * The tools `ct_docs_search_api` and `ct_docs_get_operation`: search and
 * look up the operations of the ChurchTools API in the facts of its
 * OpenAPI document, with the rights the project mapped to them with
 * evidence (ADR 0066). They read only the index, never ChurchTools.
 *
 * @packageDocumentation
 */
import type {
  DocsIndex,
  OperationRights,
} from '@ecclium/mcp-churchtools-docs-index';
import {
  classify,
  defineTool,
  EccliumError,
  type PluginHost,
} from '@ecclium/mcp-churchtools-plugin-api';
import { z } from 'zod';

import { maxPartBytes, splitIntoParts } from '../parts.js';
import {
  apiPath,
  evidenceOf,
  evidenceOutput,
  httpMethod,
  httpMethods,
  labelledRightOutput,
  labelOf,
  maxDocsHits,
  maxEvidence,
  methodOutput,
  openApiSource,
  openApiSourceOutput,
  operationIdOutput,
  pathOutput,
  rightRefOutput,
  searchInput,
  searchWithMore,
  withoutThem,
  withoutThemOutput,
} from './common.js';
import { renderDefinition } from './definition.js';

/** The highest part of a definition a call may ask for. */
export const maxDefinitionPart = 1000;

/** The message of an `operationId` the facts do not hold. */
export const operationNotFound =
  'The documentation of Ecclium has no operation with this operationId. Search the operations by words, or give method and path.';

/** The message of a method and path no operation fits. */
export const pathNotFound =
  'No operation of the documentation of Ecclium fits this method and path. Search the operations by words.';

/** The message of a call that names the operation twice or not at all. */
export const operationAskedWrongly =
  'Give either operationId, or method and path, not both.';

/**
 * The message of a method and path that fit more than one operation.
 *
 * @param operationIds - The operations that fit, sorted.
 * @returns One line for the model.
 * @example
 * ```ts
 * severalOperations(['get-a', 'get-b']);
 * // 'Several operations fit this method and path: get-a, get-b. Ask again with one operationId.'
 * ```
 */
export const severalOperations = (operationIds: readonly string[]): string =>
  `Several operations fit this method and path: ${operationIds.join(', ')}. Ask again with one operationId.`;

/**
 * The message of a part beyond the last one.
 *
 * @param parts - How many parts the definition has.
 * @returns One line for the model.
 * @example
 * ```ts
 * definitionPartOutOfRange(2);
 * // 'This definition has 2 parts. Ask for a part from 1 to 2.'
 * ```
 */
export const definitionPartOutOfRange = (parts: number): string =>
  `This definition has ${String(parts)} parts. Ask for a part from 1 to ${String(parts)}.`;

/** The notes of the rights of an operation, one for each state. */
export const rightsNotes = Object.freeze({
  needs:
    'Each entry of needs is one requirement, met by one of its rights, as far as the evidence shows. Other rights or conditions can count as well.',
  none: 'A finding showed that this operation needs no right.',
  open: 'No mapping with evidence; reason says why. The operation may still need rights.',
  unmapped:
    'Not mapped yet. The operation may need rights the documentation of Ecclium does not name.',
} as const);

// The mapping of one operation in the form of a result: one object for
// every state, because the registry takes no union of objects.
const rightsOutput = z.object({
  status: classify(z.enum(['needs', 'none', 'open', 'unmapped']), 'none'),
  needs: z
    .array(
      z.object({
        oneOf: z.array(labelledRightOutput).max(10),
        withoutThem: withoutThemOutput,
        evidence: z.array(evidenceOutput).max(maxEvidence),
      }),
    )
    .max(20),
  notNeeded: z
    .array(
      z.object({
        right: rightRefOutput,
        evidence: z.array(evidenceOutput).max(maxEvidence),
      }),
    )
    .max(20),
  noneEvidence: z.array(evidenceOutput).max(maxEvidence),
  // A reason the project writes itself, in German, without brackets
  // (ADR 0066).
  reason: classify(z.string().max(500), 'none').nullable(),
  note: classify(z.enum(Object.values(rightsNotes)), 'none'),
});

const rightsOf = (
  entry: OperationRights | undefined,
  docs: DocsIndex,
): z.input<typeof rightsOutput> => {
  const empty = {
    needs: [],
    notNeeded: [],
    noneEvidence: [],
    reason: null,
  };
  if (entry === undefined) {
    return { ...empty, status: 'unmapped', note: rightsNotes.unmapped };
  }
  const notNeeded = ('notNeeded' in entry ? (entry.notNeeded ?? []) : []).map(
    ({ right, evidence }) => ({
      right: { module: right.module, name: right.name },
      evidence: evidence.map((item) => evidenceOf(item, docs)),
    }),
  );
  if ('none' in entry) {
    return {
      ...empty,
      status: 'none',
      noneEvidence: entry.none.map((item) => evidenceOf(item, docs)),
      note: rightsNotes.none,
    };
  }
  if ('open' in entry) {
    return {
      ...empty,
      status: 'open',
      notNeeded,
      reason: entry.open,
      note: rightsNotes.open,
    };
  }
  return {
    ...empty,
    status: 'needs',
    needs: entry.needs.map((need) => ({
      oneOf: need.rights.map((right) => ({
        module: right.module,
        name: right.name,
        label: labelOf(right, docs).label,
      })),
      withoutThem: withoutThem(need.without),
      evidence: need.evidence.map((item) => evidenceOf(item, docs)),
    })),
    notNeeded,
    note: rightsNotes.needs,
  };
};

const searchOutput = z.object({
  hits: z
    .array(
      z.object({
        operationId: operationIdOutput,
        method: methodOutput,
        path: pathOutput,
        summary: classify(z.string().max(1000), 'untrusted').nullable(),
        deprecated: classify(z.boolean(), 'none'),
      }),
    )
    .max(maxDocsHits),
  more: classify(z.boolean(), 'none'),
  source: openApiSourceOutput,
});

const getInput = z.strictObject({
  operationId: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/)
    .optional(),
  // As a request or a message writes it; the facts hold small letters.
  method: z
    .enum([...httpMethods, ...httpMethods.map((m) => m.toLowerCase())])
    .optional(),
  path: z
    .string()
    .max(400)
    .regex(/^\/[\x21-\x7e]*$/)
    .optional(),
  part: z.number().int().min(1).max(maxDefinitionPart).optional(),
});

const getOutput = z.object({
  operationId: operationIdOutput,
  method: methodOutput,
  path: pathOutput,
  deprecated: classify(z.boolean(), 'none'),
  summary: classify(z.string().max(1000), 'untrusted').nullable(),
  rights: rightsOutput,
  part: classify(z.number().int().min(1).max(maxDefinitionPart), 'none'),
  parts: classify(z.number().int().min(1), 'none'),
  // A part has at most maxPartBytes bytes, so at most as many code units.
  definition: classify(z.string().max(maxPartBytes), 'untrusted'),
  source: openApiSourceOutput,
});

const meta = Object.freeze({
  capability: 'read',
  domain: 'docs',
  requiredRights: [],
  tier: 'free',
  sensitivity: 'none',
  unattended: 'policy',
  routineStable: false,
} as const);

/**
 * Adds `ct_docs_search_api`, the search over the operations, and
 * `ct_docs_get_operation`, the lookup of one operation by `operationId`
 * or by method and path, with its rights and its definition in parts.
 * Both read only the index they get.
 *
 * @param host - The host of the plugin of the core.
 * @param docs - The docs index the composition root loaded.
 * @example
 * ```ts
 * addOperationTools(host, docs);
 * ```
 */
export function addOperationTools(host: PluginHost, docs: DocsIndex): void {
  host.addTool(
    defineTool({
      name: 'ct_docs_search_api',
      meta,
      description: {
        purpose:
          'Searches the ChurchTools API operations in the OpenAPI facts that come with Ecclium; returns operationId, method, path and summary of each.',
        useWhen:
          'You look for the operation behind a task or an error, to read its parameters and rights next.',
        avoidWhen:
          'You know the operationId or method and path: look it up directly.',
        limits:
          'Words match the English texts of the document only. At most 25 hits, best first.',
      },
      input: searchInput,
      output: searchOutput,
      execute: ({ input }) => {
        const { hits, more } = searchWithMore(
          (query, limit) => docs.searchOperations(query, limit),
          input,
        );
        return Promise.resolve({
          hits: hits.map((hit) => ({
            operationId: hit.operationId,
            method: httpMethod(hit.method),
            path: apiPath(hit.path),
            summary: hit.summary ?? null,
            deprecated: hit.deprecated,
          })),
          more,
          source: openApiSource(docs.sources),
        });
      },
    }),
  );
  host.addTool(
    defineTool({
      name: 'ct_docs_get_operation',
      meta,
      description: {
        purpose:
          'Reads one ChurchTools API operation from its OpenAPI facts: method, path, parameters, body, answers and the rights it needs, with evidence.',
        useWhen:
          'You know its operationId, or method and path such as GET /api/groups/12/members, and need to call it or find the right a failed request lacked.',
        avoidWhen:
          'You only know what you want to do: search the operations first.',
        limits:
          'The definition comes as text in parts of at most 16000 bytes, schemas three levels deep. Rights stand only where mapped with evidence; else a right may still be needed.',
      },
      input: getInput,
      output: getOutput,
      execute: ({ input: { operationId, method, path, part = 1 } }) => {
        const byPath = method !== undefined || path !== undefined;
        if (
          (operationId !== undefined) === byPath ||
          (byPath && (method === undefined || path === undefined))
        ) {
          throw new EccliumError('validation', operationAskedWrongly);
        }
        let id = operationId;
        if (method !== undefined && path !== undefined) {
          const found = docs.findOperationsByPath(method.toLowerCase(), path);
          if (found.length === 0) {
            throw new EccliumError('not_found', pathNotFound);
          }
          if (found.length > 1) {
            throw new EccliumError('validation', severalOperations(found));
          }
          [id] = found;
        }
        const operation = id === undefined ? undefined : docs.getOperation(id);
        if (operation === undefined) {
          throw new EccliumError('not_found', operationNotFound);
        }
        const { fact } = operation;
        // The parts come from the facts, so the same index always gives the
        // same parts.
        const parts = splitIntoParts(renderDefinition(fact));
        const definition = parts[part - 1];
        if (definition === undefined) {
          throw new EccliumError(
            'validation',
            definitionPartOutOfRange(parts.length),
          );
        }
        return Promise.resolve({
          operationId: fact.operationId,
          method: httpMethod(fact.method),
          path: apiPath(fact.path),
          deprecated: fact.deprecated,
          summary: fact.summary ?? null,
          rights: rightsOf(operation.rights, docs),
          part,
          parts: parts.length,
          definition,
          source: openApiSource(docs.sources),
        });
      },
    }),
  );
}
