/**
 * The tools `ct_docs_search_rights` and `ct_docs_get_right`: search and
 * look up the rights of ChurchTools, with their labels, the help pages
 * that explain them and the operations the project mapped to them with
 * evidence (ADR 0066). They read only the index, never ChurchTools.
 *
 * @packageDocumentation
 */
import type { DocsIndex, RightHit } from '@ecclium/mcp-churchtools-docs-index';
import {
  classify,
  defineTool,
  EccliumError,
  type PluginHost,
} from '@ecclium/mcp-churchtools-plugin-api';
import { z } from 'zod';

import {
  academyLinkOutput,
  academyPathOutput,
  academySource,
  academySourceOutput,
  apiPath,
  evidenceOf,
  evidenceOutput,
  httpMethod,
  labelOf,
  labelSourceOutput,
  maxDocsHits,
  maxEvidence,
  methodOutput,
  moduleOutput,
  operationIdOutput,
  pathOutput,
  permissionsSource,
  permissionsSourceOutput,
  rightNameOutput,
  rightRefOutput,
  searchInput,
  searchWithMore,
  withoutThem,
  withoutThemOutput,
} from './common.js';

/** The most operations a lookup of a right names in each list. */
export const maxRightOperations = 50;

/** The message of a right the facts do not hold. */
export const rightNotFound =
  'The documentation of Ecclium has no right with this module and name. Search the rights to find module and name.';

/** The note of every lookup of a right. */
export const rightNote =
  'Only operations the project mapped with evidence appear; others may need this right too.';

const kindOutput = classify(z.enum(['boolean', 'list']), 'none');
const labelOutput = classify(z.string().max(200), 'untrusted').nullable();

const searchOutput = z.object({
  hits: z
    .array(
      z.object({
        module: moduleOutput,
        name: rightNameOutput,
        kind: kindOutput,
        label: labelOutput,
        labelSource: labelSourceOutput.nullable(),
      }),
    )
    .max(maxDocsHits),
  more: classify(z.boolean(), 'none'),
  source: permissionsSourceOutput,
  academy: academySourceOutput,
});

// Strict, so that an argument the model made up ends as a validation
// error. Module and name in the form the facts allow.
const name = (max: number) =>
  classify(
    z
      .string()
      .max(max)
      .regex(/^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/),
    'none',
  );
const getInput = z.strictObject({ module: name(32), name: name(64) });

const operationOutput = {
  operationId: operationIdOutput,
  method: methodOutput,
  path: pathOutput,
};

const getOutput = z.object({
  module: moduleOutput,
  name: rightNameOutput,
  kind: kindOutput,
  label: labelOutput,
  labelSource: labelSourceOutput.nullable(),
  pages: z
    .array(
      z.object({
        title: classify(z.string().max(300), 'untrusted'),
        path: academyPathOutput,
        link: academyLinkOutput,
      }),
    )
    .max(20),
  neededBy: z
    .array(
      z.object({
        ...operationOutput,
        // The right of the lookup and the others of the same pairing, of
        // which one suffices.
        oneOf: z.array(rightRefOutput).max(10),
        withoutThem: withoutThemOutput,
        evidence: z.array(evidenceOutput).max(maxEvidence),
      }),
    )
    .max(maxRightOperations),
  moreNeededBy: classify(z.boolean(), 'none'),
  notNeededBy: z
    .array(
      z.object({
        ...operationOutput,
        evidence: z.array(evidenceOutput).max(maxEvidence),
      }),
    )
    .max(maxRightOperations),
  moreNotNeededBy: classify(z.boolean(), 'none'),
  note: classify(z.literal(rightNote), 'none'),
  source: permissionsSourceOutput,
  academy: academySourceOutput,
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
 * Adds `ct_docs_search_rights`, the search over the rights by module,
 * name and label, and `ct_docs_get_right`, the lookup of one right with
 * its label, pages and the operations that need it or, by a finding, do
 * not. Both read only the index they get.
 *
 * @param host - The host of the plugin of the core.
 * @param docs - The docs index the composition root loaded.
 * @example
 * ```ts
 * addRightTools(host, docs);
 * ```
 */
export function addRightTools(host: PluginHost, docs: DocsIndex): void {
  host.addTool(
    defineTool({
      name: 'ct_docs_search_rights',
      meta,
      description: {
        purpose:
          'Searches ChurchTools rights by module, name or German label; returns module, name, kind and label of each.',
        useWhen:
          'You need the exact name of a right, for example from the wording of the web interface.',
        avoidWhen:
          'You want the rights an API operation needs: read the operation, whose rights rest on evidence.',
        limits:
          'Labels describe the web interface, not the API. At most 25 hits, best first.',
      },
      input: searchInput,
      output: searchOutput,
      execute: ({ input }) => {
        const { hits, more } = searchWithMore(
          (query, limit) => docs.searchRights(query, limit),
          input,
        );
        return Promise.resolve({
          hits: hits.map((hit: RightHit) => {
            const { label, labelSource } = labelOf(hit, docs);
            return {
              module: hit.module,
              name: hit.name,
              kind: hit.kind,
              label,
              labelSource,
            };
          }),
          more,
          source: permissionsSource(docs.sources),
          academy: academySource(docs.sources),
        });
      },
    }),
  );
  host.addTool(
    defineTool({
      name: 'ct_docs_get_right',
      meta,
      description: {
        purpose:
          'Reads one ChurchTools right by module and name: kind, label, explaining help pages and the API operations that need it or, by a finding, do not.',
        useWhen:
          'You know a right, from an operation or the account, and need its meaning or the operations it opens.',
        avoidWhen: 'You only know its label: search the rights first.',
        limits:
          'Lists only operations mapped with evidence, at most 50 each; others may need the right too.',
      },
      input: getInput,
      output: getOutput,
      execute: ({ input }) => {
        const right = docs.getRight(input.module, input.name);
        if (right === undefined) {
          throw new EccliumError('not_found', rightNotFound);
        }
        const { fact } = right;
        const { label, labelSource } = labelOf(fact, docs);
        const neededBy = right.neededBy.slice(0, maxRightOperations);
        const notNeededBy = right.notNeededBy.slice(0, maxRightOperations);
        return Promise.resolve({
          module: fact.module,
          name: fact.name,
          kind: fact.kind,
          label,
          labelSource,
          pages: right.pages.map(({ path, attribution }) => ({
            title: attribution.title,
            path,
            link: attribution.link,
          })),
          neededBy: neededBy.map(({ operationId, method, path, need }) => ({
            operationId,
            method: httpMethod(method),
            path: apiPath(path),
            oneOf: need.rights.map((item) => ({
              module: item.module,
              name: item.name,
            })),
            withoutThem: withoutThem(need.without),
            evidence: need.evidence.map((item) => evidenceOf(item, docs)),
          })),
          moreNeededBy: right.neededBy.length > neededBy.length,
          notNeededBy: notNeededBy.map(
            ({ operationId, method, path, notNeeded }) => ({
              operationId,
              method: httpMethod(method),
              path: apiPath(path),
              evidence: notNeeded.evidence.map((item) =>
                evidenceOf(item, docs),
              ),
            }),
          ),
          moreNotNeededBy: right.notNeededBy.length > notNeededBy.length,
          note: rightNote,
          source: permissionsSource(docs.sources),
          academy: academySource(docs.sources),
        });
      },
    }),
  );
}
