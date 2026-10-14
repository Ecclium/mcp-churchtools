/**
 * The schema of an audit event of version 1 (ADR 0028, ADR 0054). Every
 * field has a pattern or a closed list. The patterns keep out e-mail
 * addresses, spaces, line breaks and other free text. A name written as a
 * slug, such as max-mustermann, still fits the ID of a tenant, a routine or
 * an actor, so these come only from the configuration and the identity.
 *
 * @packageDocumentation
 */
import {
  type ActorKind,
  type AuditOutcome,
  type ConfirmationPath,
  errorCodes,
} from '@ecclium/mcp-churchtools-plugin-api';
import { z } from 'zod';

import {
  modes,
  tenantIdPattern,
  timestampPattern,
  toolNamePattern,
  uuidPattern,
} from '../logger/index.js';

/** Every {@link ActorKind}, frozen. */
export const actorKinds: readonly ActorKind[] = Object.freeze([
  'service',
  'user',
  'runner',
  'operator',
]);

/** Every {@link AuditOutcome}, frozen. */
export const auditOutcomes: readonly AuditOutcome[] = Object.freeze([
  'ok',
  'error',
  'denied',
]);

/** Every {@link ConfirmationPath}, frozen. */
export const confirmationPaths: readonly ConfirmationPath[] = Object.freeze([
  'elicitation',
  'echo',
  'policy',
  'operator',
]);

/** The most entries a list in an audit event may have. */
export const auditLimits = Object.freeze({
  objectRefs: 100,
  pluginHashes: 64,
});

/**
 * The kinds of objects an entry of `objectRefs` may name, frozen. A closed
 * list, so that the part before the colon cannot carry a name.
 */
export const objectDomains: readonly string[] = Object.freeze([
  'person',
  'group',
  'wiki_category',
  'wiki_page',
]);

// Regular expressions without flags, like those of the logger. An actor ID
// is a neutral name such as stdio:local-operator, never an e-mail address: no
// capital letter, no dot, no @ and no space. A name as a slug would fit, so
// the identity must not make one (ADR 0003).
const actorIdPattern = /^[a-z][a-z0-9_-]{0,31}(?::[a-z0-9_-]{1,64})?$/;
const hashPattern = /^[0-9a-f]{64}$/;
const vendorPattern = /^[a-z][a-z0-9-]{0,31}$/;
const modelPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const countryPattern = /^[A-Z]{2}$/;
// A host name in lower case without port, user, path or a dot at the end.
const hostPattern =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
// A term such as eu_gdpr, never text with spaces or dots. Which terms exist
// is still open; until then any term of this form fits.
const termPattern = /^[a-z][a-z0-9_]{0,31}$/;
// A kind from objectDomains and the ID of an object, such as person:1, never
// its name. A test keeps the alternatives in line with the list.
const objectRefPattern =
  /^(?:person|group|wiki_category|wiki_page):(?:[0-9]{1,16}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

// The length is checked first and stops the check, so that a huge string
// never reaches its pattern.
const text = (maxLength: number, pattern: RegExp) =>
  z.string().max(maxLength, { abort: true }).regex(pattern);

/** The schemas of the single fields, which the sink checks one by one. */
export const auditFieldSchemas = Object.freeze({
  eventId: text(36, uuidPattern),
  ts: text(24, timestampPattern),
  type: z.literal('tool_call'),
  tenantId: text(63, tenantIdPattern),
  actorKind: z.enum(actorKinds),
  actorId: text(97, actorIdPattern),
  mode: z.enum(modes),
  runId: text(36, uuidPattern),
  routineId: text(63, tenantIdPattern),
  tool: text(63, toolNamePattern),
  outcome: z.enum(auditOutcomes),
  confirmation: z.enum(confirmationPaths),
  hash: text(64, hashPattern),
  vendor: text(32, vendorPattern),
  model: text(64, modelPattern),
  hostingCountry: text(2, countryPattern),
  endpointHost: text(253, hostPattern),
  term: text(32, termPattern),
  objectRef: text(50, objectRefPattern),
  errorCode: z.enum(errorCodes),
  durationMs: z.int().min(0).max(86_400_000),
  seq: z.int().min(0),
});

const fields = auditFieldSchemas;

/**
 * An audit event of version 1. Strict: an unknown key fails it. An event
 * with the outcome `ok` has no error code, and one with `error` or `denied`
 * has one.
 */
export const auditEventV1Schema = z
  .strictObject({
    v: z.literal(1),
    eventId: fields.eventId,
    ts: fields.ts,
    type: fields.type,
    tenantId: fields.tenantId,
    actor: z
      .strictObject({ kind: fields.actorKind, id: fields.actorId })
      .readonly(),
    mode: fields.mode,
    runId: fields.runId.optional(),
    routineId: fields.routineId.optional(),
    tool: fields.tool.optional(),
    outcome: fields.outcome,
    confirmation: fields.confirmation.optional(),
    policyHash: fields.hash.optional(),
    provider: z
      .strictObject({
        vendor: fields.vendor,
        model: fields.model,
        hostingCountry: fields.hostingCountry,
        endpointHost: fields.endpointHost,
        transferBasis: fields.term.optional(),
      })
      .readonly()
      .optional(),
    pluginHashes: z
      .array(fields.hash)
      .max(auditLimits.pluginHashes)
      .readonly()
      .optional(),
    dataProtectionRegime: fields.term.optional(),
    objectRefs: z
      .array(fields.objectRef)
      .max(auditLimits.objectRefs)
      .readonly(),
    errorCode: fields.errorCode.optional(),
    durationMs: fields.durationMs,
    seq: fields.seq.optional(),
    prevHash: fields.hash.optional(),
  })
  // The output of zod is an ordinary object, so only an own error code
  // counts: one added to Object.prototype must not fail a valid event.
  .refine(
    (event) =>
      (event.outcome === 'ok') ===
      (!Object.hasOwn(event, 'errorCode') || event.errorCode === undefined),
  )
  .readonly();

/**
 * Values the sink writes instead of an invalid required field. Each one
 * passes the schema. The configuration must refuse the tenant `invalid` and
 * the actor `invalid`, and the registry the tool `ct_unknown`, so that a
 * placeholder is never taken for a real value.
 */
export const auditPlaceholders = Object.freeze({
  eventId: '00000000-0000-0000-0000-000000000000',
  ts: '1970-01-01T00:00:00.000Z',
  type: 'tool_call',
  tenantId: 'invalid',
  actor: Object.freeze({ kind: 'service', id: 'invalid' }),
  mode: 'unattended',
  tool: 'ct_unknown',
  outcome: 'error',
  objectRefs: Object.freeze([]),
  errorCode: 'internal',
  durationMs: 0,
} as const);
