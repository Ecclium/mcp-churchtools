/**
 * The schemas of the client as JSON Schema, for the local contract check
 * against the OpenAPI document of an instance (ADR 0057). The mode `input`
 * describes what ChurchTools may send; the mode `output` would mark every
 * object as closed and declare the other fields of an answer forbidden.
 *
 * @packageDocumentation
 */
import { z } from 'zod';

import {
  countedMetaSchema,
  groupListSchema,
  pagedMetaSchema,
  personListSchema,
  rightValueSchema,
  whoamiSchema,
  wikiCategoryListSchema,
  wikiPageListSchema,
  wikiPageSchema,
} from './schemas.js';

/**
 * Describes each operation of the client and each building block with its
 * schema, in a fixed order.
 *
 * @returns Method, path and JSON Schema of each entry.
 * @example
 * ```ts
 * describeContract().whoami.path; // '/api/whoami'
 * ```
 */
export function describeContract() {
  const schema = (value: z.ZodType) => z.toJSONSchema(value, { io: 'input' });
  return {
    whoami: {
      method: 'get',
      path: '/api/whoami',
      query: ['only_allow_authenticated'],
      response: schema(whoamiSchema),
    },
    permissions: {
      method: 'get',
      path: '/api/permissions/global',
      query: [],
      value: schema(rightValueSchema),
    },
    searchPersons: {
      method: 'get',
      path: '/api/persons',
      query: ['query', 'page', 'limit'],
      response: schema(personListSchema),
    },
    searchGroups: {
      method: 'get',
      path: '/api/groups',
      query: ['query', 'page', 'limit'],
      response: schema(groupListSchema),
    },
    wikiCategories: {
      method: 'get',
      path: '/api/wiki/categories',
      query: [],
      response: schema(wikiCategoryListSchema),
    },
    wikiPages: {
      method: 'get',
      path: '/api/wiki/pages',
      query: ['wiki_category_ids[]', 'page', 'limit'],
      response: schema(wikiPageListSchema),
    },
    // A page and one of its versions have the same form (F19).
    wikiPage: {
      method: 'get',
      path: '/api/wiki/categories/{categoryId}/pages/{identifier}',
      query: [],
      response: schema(wikiPageSchema),
    },
    wikiPageVersion: {
      method: 'get',
      path: '/api/wiki/categories/{categoryId}/pages/{identifier}/versions/{version}',
      query: [],
      response: schema(wikiPageSchema),
    },
    pagedMeta: { meta: schema(pagedMetaSchema) },
    countedMeta: { meta: schema(countedMetaSchema) },
  };
}
