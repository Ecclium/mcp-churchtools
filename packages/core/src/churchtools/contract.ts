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
  pagedMetaSchema,
  rightValueSchema,
  whoamiSchema,
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
    pagedMeta: { meta: schema(pagedMetaSchema) },
    countedMeta: { meta: schema(countedMetaSchema) },
  };
}
