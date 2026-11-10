/**
 * The content of an entry of the queue of approvals and how it is sealed
 * (ADR 0031).
 *
 * Where it stands in the way of a write: when a plan goes to the queue
 * instead of a question or the echo, the write guard turns it into the
 * plain record below, and this module seals it before any store sees it.
 * A fresh key of 256 bits per entry encrypts the content with AES-256-GCM
 * from node:crypto, and the provider of keys wraps that key with the day
 * key `queue` of the day (`KeyProvider.wrap`). The store gets only the
 * wrapped key and the ciphertext. Once the day key is destroyed, after 14
 * days, the entry cannot be opened in any copy. `ecclium queue` opens the
 * entries again and checks every field before it shows or uses one.
 *
 * An entry holds what the operator needs to decide and what the core
 * needs to plan the write again for an approval: the tool and its
 * metadata, the actor of the wish, the checked intent with its texts, the
 * hash of the plan, the target, the summary and the diff the person would
 * have seen, and why the write waits here. The intent is checked as an
 * intent again when the write guard plans it anew; here only its form.
 *
 * @packageDocumentation
 */
import { createCipheriv, createDecipheriv, randomFillSync } from 'node:crypto';
import { isProxy } from 'node:util/types';

import {
  type Actor,
  dataKeyLength,
  isIsoDate,
  type IsoDate,
  type KeyProvider,
  maxSealedQueueEntryLength,
  type Reversible,
  type SealedQueueEntry,
  type Sensitivity,
  type TenantContext,
  type UnattendedRule,
  type WriteIntent,
  writeIntentKinds,
  type WriteTargetKind,
  writeTargetKinds,
} from '@ecclium/mcp-churchtools-plugin-api';
import { z } from 'zod';

import { actorKinds, isActorId } from '../audit/schema.js';
import { infoOf } from '../keys/index.js';
import { isTenantId, isUuid, toolNamePattern } from '../logger/index.js';

/**
 * Why a write waits in the queue (ADR 0029, ADR 0032). The first five come
 * from the policy: an intent that always goes there or a target that needs
 * an entry (`queue_only`), no entry for this tool and target, a name that
 * changed, the limit of the day, and a counter that could not be read.
 * The other three come from the way of the confirmation: the setting
 * `queue`, a client that cannot be asked while the echo does not confirm
 * the plan, and a diff too long for a question. `marker_changed` is an own
 * section a person changed, and `rights_drift` a write of a run whose
 * account has rights its routines do not need (ADR 0032).
 */
export type QueueReason =
  | 'queue_only'
  | 'no_entry'
  | 'name_changed'
  | 'limit_reached'
  | 'count_unavailable'
  | 'setting'
  | 'no_question'
  | 'too_long'
  | 'marker_changed'
  | 'rights_drift';

/** Every {@link QueueReason}, frozen, the policy first. */
export const queueReasons: readonly QueueReason[] = Object.freeze([
  'queue_only',
  'no_entry',
  'name_changed',
  'limit_reached',
  'count_unavailable',
  'setting',
  'no_question',
  'too_long',
  'marker_changed',
  'rights_drift',
]);

/** What an entry of the queue holds, as the write guard made it. */
export interface QueueEntryContent {
  /** The tool that planned the write. */
  readonly tool: string;
  /** Who brings the tool, as the catalog recorded it. */
  readonly origin: 'core' | 'plugin';
  /** The metadata of the tool that the plan was sealed with. */
  readonly toolMeta: {
    readonly sensitivity: Sensitivity;
    readonly unattended: UnattendedRule;
    readonly reversible?: Reversible;
  };
  /** The actor of the call that asked for the write. */
  readonly actor: Actor;
  /** The intent as the write guard checked it, its texts as written. */
  readonly intent: WriteIntent;
  /** The hash of the plan, which an approval must find again. */
  readonly planHash: string;
  /** What the write changes, as the result and the audit name it. */
  readonly target: { readonly kind: WriteTargetKind; readonly key: string };
  /** The summary in German, as a question would have shown it. */
  readonly summary: string;
  /** The whole title of a new page, made visible. */
  readonly title?: string;
  /** The diff as lines to read, every character visible. */
  readonly diff: readonly string[];
  /** Why the write waits in the queue. */
  readonly reason: QueueReason;
  /** When it was queued, in milliseconds since the Unix epoch. */
  readonly queuedAt: number;
  /**
   * The UTC day the write was planned, which the line of the marking of a
   * new page or a section names (ADR 0032). An entry of an earlier
   * version has none.
   */
  readonly plannedOn?: IsoDate;
  /**
   * For a write of a run of a routine, the run: routine and period name
   * its line of the marking, and the keys of the contact values from the
   * data of the run that its text holds (ADR 0030, ADR 0032). An approval
   * judges such an entry against the entries of the routine.
   */
  readonly run?: {
    readonly routine: string;
    readonly period: string;
    readonly contacts: readonly string[];
  };
}

const hash = z.string().regex(/^[0-9a-f]{64}$/);
// The period of a run as the line of the marking names it, such as
// 2026-W46: letters, digits and hyphens.
const periodPattern = /^[0-9A-Za-z][0-9A-Za-z-]{0,31}$/;
const json = z.json();
// An intent as a plain object of JSON values with a kind the core knows;
// whether it fits its kind the write guard checks when it plans again.
const intentSchema = z
  .record(z.string(), json)
  .refine(
    (value) =>
      typeof value['kind'] === 'string' &&
      (writeIntentKinds as readonly string[]).includes(value['kind']),
  );

// The form an entry must have, checked again when it is opened: one that
// opens but does not fit is refused, whoever made it.
const contentSchema = z.strictObject({
  tool: z.string().regex(toolNamePattern),
  origin: z.enum(['core', 'plugin']),
  toolMeta: z.strictObject({
    sensitivity: z.enum(['none', 'personal', 'special']),
    unattended: z.enum(['never', 'policy']),
    reversible: z.enum(['yes', 'no', 'snapshot']).optional(),
  }),
  actor: z.strictObject({
    kind: z.enum(actorKinds),
    id: z.string().refine(isActorId),
  }),
  intent: intentSchema,
  planHash: hash,
  target: z.strictObject({
    kind: z.enum(writeTargetKinds),
    key: z.string().min(1).max(200),
  }),
  // Title and diff are bounded by the length of the sealed entry alone: a
  // diff too long for a question is what the queue is for, and its lines
  // come from the page and grow when they are made visible.
  summary: z.string().min(1).max(2000),
  title: z.string().optional(),
  diff: z.array(z.string()),
  reason: z.enum(queueReasons),
  queuedAt: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
  plannedOn: z.string().refine(isIsoDate).optional(),
  run: z
    .strictObject({
      routine: z.string().refine(isTenantId),
      period: z.string().regex(periodPattern),
      contacts: z.array(z.string().min(1).max(254)).max(100),
    })
    .optional(),
});
const recordSchema = z.strictObject({
  v: z.literal(1),
  content: contentSchema,
});

// The first part of the additional data of every entry: the version of
// the format. Tenant, instance, ID and day follow, so that an entry moved
// to another place of the store never opens there.
const label = 'ecclium/queue/v1';
const nonceLength = 12;
const tagLength = 16;
const wrappedPattern = /^[A-Za-z0-9_-]{80}$/;
const dataPattern = /^[A-Za-z0-9_-]+$/;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

// An own data property of a plain object, never through a getter or a
// proxy.
const ownData = (target: unknown, key: string): unknown => {
  if (typeof target !== 'object' || target === null || isProxy(target)) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  return descriptor !== undefined && 'value' in descriptor
    ? (descriptor.value as unknown)
    : undefined;
};

const aadOf = (ctx: TenantContext, id: string, day: IsoDate): Uint8Array => {
  const tenantId = ownData(ctx, 'tenantId');
  const instance = ownData(ctx, 'instance');
  if (!isTenantId(tenantId) || typeof instance !== 'string') {
    throw new TypeError('The context of an entry is invalid.');
  }
  return infoOf([label, tenantId, instance, id, day]);
};

/** What {@link sealQueueEntry} seals. */
export interface QueueEntryToSeal {
  /** The ID of the entry, the ID of the audit event of the call. */
  readonly id: string;
  /** The UTC day, which picks the day key. */
  readonly day: IsoDate;
  /** What the entry holds. */
  readonly content: QueueEntryContent;
}

/**
 * Seals an entry of the queue for a store.
 *
 * @param keys - The provider of keys with the day keys.
 * @param ctx - The context of the call that queued, for tenant and
 *   instance.
 * @param entry - ID, day and content.
 * @returns The sealed entry, frozen.
 * @throws {TypeError} For an ID, day or content that does not fit, or an
 *   entry longer than a store keeps.
 * @example
 * ```ts
 * const sealed = await sealQueueEntry(keys, ctx, { id: eventId, day, content });
 * await queue.put(ctx, sealed);
 * ```
 */
export async function sealQueueEntry(
  keys: Pick<KeyProvider, 'wrap'>,
  ctx: TenantContext,
  entry: QueueEntryToSeal,
): Promise<SealedQueueEntry> {
  const { id, day, content } = entry;
  if (!isUuid(id) || !isIsoDate(day)) {
    throw new TypeError('The entry does not fit.');
  }
  const record = recordSchema.safeParse({ v: 1, content });
  if (!record.success) throw new TypeError('The entry does not fit.');
  const aad = aadOf(ctx, id, day);
  const key = randomFillSync(new Uint8Array(dataKeyLength));
  const plain = encoder.encode(JSON.stringify(record.data));
  try {
    const nonce = randomFillSync(new Uint8Array(nonceLength));
    const cipher = createCipheriv('aes-256-gcm', key, nonce, {
      authTagLength: tagLength,
    });
    cipher.setAAD(aad);
    const data = Buffer.concat([
      nonce,
      cipher.update(plain),
      cipher.final(),
      cipher.getAuthTag(),
    ]).toString('base64url');
    const wrapped = await keys.wrap(ctx, 'queue', day, key);
    const sealed = `${wrapped.sealed}.${data}`;
    if (sealed.length > maxSealedQueueEntryLength) {
      throw new TypeError('The entry is too large.');
    }
    return Object.freeze({ id, day, sealed });
  } finally {
    key.fill(0);
    plain.fill(0);
  }
}

/**
 * Opens an entry that {@link sealQueueEntry} sealed for the same tenant
 * and instance.
 *
 * @param keys - The provider of keys with the day keys.
 * @param ctx - The context, for tenant and instance.
 * @param entry - The sealed entry from the store.
 * @returns What it holds, or undefined when its day key is gone: its
 *   retention is over.
 * @throws {Error} When the entry was changed, belongs elsewhere or does
 *   not hold an entry of the queue.
 * @example
 * ```ts
 * const content = await openQueueEntry(keys, ctx, sealed);
 * if (content === undefined) report('expired');
 * ```
 */
export async function openQueueEntry(
  keys: Pick<KeyProvider, 'unwrap'>,
  ctx: TenantContext,
  entry: SealedQueueEntry,
): Promise<QueueEntryContent | undefined> {
  const id = ownData(entry, 'id');
  const day = ownData(entry, 'day');
  const sealed = ownData(entry, 'sealed');
  if (!isUuid(id) || !isIsoDate(day) || typeof sealed !== 'string') {
    throw new Error('The entry does not open.');
  }
  const [wrappedKey, data, rest] = sealed.split('.');
  if (
    rest !== undefined ||
    wrappedKey === undefined ||
    data === undefined ||
    !wrappedPattern.test(wrappedKey) ||
    !dataPattern.test(data)
  ) {
    throw new Error('The entry does not open.');
  }
  const bytes = Buffer.from(data, 'base64url');
  if (bytes.length < nonceLength + tagLength) {
    throw new Error('The entry does not open.');
  }
  const aad = aadOf(ctx, id, day);
  const key = await keys.unwrap(ctx, 'queue', {
    purpose: 'queue',
    day,
    sealed: wrappedKey,
  });
  if (key === undefined) return undefined;
  let plain: Buffer;
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key,
      bytes.subarray(0, nonceLength),
      { authTagLength: tagLength },
    );
    decipher.setAAD(aad);
    decipher.setAuthTag(bytes.subarray(bytes.length - tagLength));
    plain = decipher.update(
      bytes.subarray(nonceLength, bytes.length - tagLength),
    );
    try {
      decipher.final();
    } catch {
      plain.fill(0);
      throw new Error('The entry does not open.');
    }
  } finally {
    key.fill(0);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(plain));
  } catch {
    throw new Error('The entry does not open.');
  } finally {
    plain.fill(0);
  }
  const record = recordSchema.safeParse(parsed);
  if (!record.success) throw new Error('The entry does not open.');
  // The schema checks the intent as JSON of a kind the core knows; the
  // write guard checks it as an intent of that kind before it plans.
  return record.data.content as unknown as QueueEntryContent;
}
