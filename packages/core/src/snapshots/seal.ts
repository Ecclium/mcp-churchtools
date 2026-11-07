/**
 * The content of a snapshot and how it is sealed (ADR 0031).
 *
 * Where it stands in the way of a write: right before the one send of a
 * commit, the write guard saves what the target held, and after a new
 * page is read back, its GUID. Each part is sealed here before any store
 * sees it: a fresh key of 256 bits per record encrypts the content with
 * AES-256-GCM from node:crypto, and the provider of keys wraps that key
 * with the day key of the day (`KeyProvider.wrap`). The store gets only
 * the wrapped key and the ciphertext. Once the day key is destroyed, after
 * 30 days, the record cannot be opened in any copy. `ecclium undo` opens
 * the records again and checks every field before it uses one.
 *
 * Only the changed field is kept, never a whole record of ChurchTools: the
 * text of a page before the write, or for a new page its category, title
 * and the hash of its text, and afterwards its GUID; the fields of an
 * appointment a change writes; for a new appointment or booking its place
 * and the hash of its fields, for a booking also its time, and afterwards
 * its ID, for a booking also its status.
 *
 * @packageDocumentation
 */
import { createCipheriv, createDecipheriv, randomFillSync } from 'node:crypto';
import { isProxy } from 'node:util/types';

import {
  dataKeyLength,
  isIsoDate,
  type IsoDate,
  type KeyProvider,
  maxSealedSnapshotLength,
  type SealedSnapshot,
  type SnapshotPart,
  snapshotParts,
  type TenantContext,
  wikiPageGuidPattern,
} from '@ecclium/mcp-churchtools-plugin-api';
import { z } from 'zod';

import { infoOf } from '../keys/index.js';
import { isTenantId, isUuid, toolNamePattern } from '../logger/index.js';

/** What a snapshot keeps of a page whose text a write changes. */
export interface PageTextSnapshot {
  readonly kind: 'wikiPageText';
  /** The tool whose write it was. */
  readonly tool: string;
  readonly categoryId: number;
  /** The GUID of the page, as the write sent it. */
  readonly guid: string;
  /** The page before the write. */
  readonly before: { readonly version: number; readonly text: string };
  /** What the write leaves: the next version and the hash of its text. */
  readonly after: { readonly version: number; readonly textHash: string };
}

/** What a snapshot keeps of a page a write creates, before it is sent. */
export interface PageCreateSnapshot {
  readonly kind: 'wikiPageCreate';
  readonly tool: string;
  readonly categoryId: number;
  readonly title: string;
  /** The hash of the text the page gets. */
  readonly textHash: string;
}

/** The fields of an appointment a change writes (ADR 0072). */
export interface AppointmentFieldsState {
  readonly title: string;
  readonly subtitle: string | null;
  readonly description: string | null;
  readonly startDate: string;
  readonly endDate: string;
  readonly isInternal: boolean;
}

/** What a snapshot keeps of an appointment whose fields a write changes. */
export interface AppointmentFieldsSnapshot {
  readonly kind: 'appointmentFields';
  readonly tool: string;
  readonly calendarId: number;
  readonly appointmentId: number;
  /** The appointment before the write: its version and its fields. */
  readonly before: AppointmentFieldsState & { readonly version: number };
  /** What the write leaves: the next version and the hash of the fields. */
  readonly after: { readonly version: number; readonly fieldsHash: string };
}

/**
 * What a snapshot keeps of an appointment a write creates, before it is
 * sent: where, and the hash of the fields it gets.
 */
export interface AppointmentCreateSnapshot {
  readonly kind: 'appointmentCreate';
  readonly tool: string;
  /** The calendar of the appointment. */
  readonly placeId: number;
  readonly fieldsHash: string;
}

/**
 * What a snapshot keeps of a booking a write requests, before it is sent:
 * the resource, the hash of the fields and the time, since only the list
 * of its days tells whether a booking is gone (F47).
 */
export interface BookingCreateSnapshot {
  readonly kind: 'bookingCreate';
  readonly tool: string;
  /** The resource of the booking. */
  readonly placeId: number;
  readonly fieldsHash: string;
  readonly startDate: string;
  readonly endDate: string;
}

/** What a snapshot keeps of an appointment or a booking a write creates. */
export type DatedCreateSnapshot =
  AppointmentCreateSnapshot | BookingCreateSnapshot;

/** The part `before` of a snapshot of the wiki. */
export type WikiSnapshotState = PageTextSnapshot | PageCreateSnapshot;

/** The part `before` of a snapshot. */
export type SnapshotState =
  WikiSnapshotState | AppointmentFieldsSnapshot | DatedCreateSnapshot;

/** The part `after` of the snapshot of a new page, once it is read back. */
export interface PageCreatedSnapshot {
  readonly kind: 'wikiPageCreated';
  readonly guid: string;
  readonly version: number;
}

/**
 * The part `after` of the snapshot of a new appointment, once ChurchTools
 * named it: its ID and the version it was created with.
 */
export interface AppointmentCreatedSnapshot {
  readonly kind: 'appointmentCreated';
  readonly id: number;
  readonly version: number;
}

/**
 * The part `after` of the snapshot of a new booking, once ChurchTools named
 * it: its ID, the version and the status it was created with, since an
 * approval need not raise the version and an undo deletes no booking whose
 * status changed.
 */
export interface BookingCreatedSnapshot {
  readonly kind: 'bookingCreated';
  readonly id: number;
  readonly version: number;
  readonly statusId: number;
}

/** The part `after` of the snapshot of a new appointment or booking. */
export type DatedCreatedSnapshot =
  AppointmentCreatedSnapshot | BookingCreatedSnapshot;

/** The part `after` of a snapshot. */
export type SnapshotOutcome = PageCreatedSnapshot | DatedCreatedSnapshot;

/** What a part of a snapshot holds. */
export type SnapshotContent = SnapshotState | SnapshotOutcome;

const hash = z.string().regex(/^[0-9a-f]{64}$/);
const version = z.int().min(0).max(Number.MAX_SAFE_INTEGER);
const id = z.int().min(1).max(Number.MAX_SAFE_INTEGER);
// The GUID as ChurchTools gave it, in either case: `ecclium undo` compares
// it without case, as the target of the audit does in lower case.
const guid = z.string().regex(wikiPageGuidPattern);
const tool = z.string().regex(toolNamePattern);

// The forms a part may take, checked again when it is opened: a record
// that opens but does not fit is refused, whoever made it.
const stateSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('wikiPageText'),
    tool,
    categoryId: id,
    guid,
    before: z.strictObject({ version, text: z.string() }),
    after: z.strictObject({ version, textHash: hash }),
  }),
  z.strictObject({
    kind: z.literal('wikiPageCreate'),
    tool,
    categoryId: id,
    title: z.string(),
    textHash: hash,
  }),
  z.strictObject({
    kind: z.literal('appointmentFields'),
    tool,
    calendarId: id,
    appointmentId: id,
    before: z.strictObject({
      version,
      title: z.string(),
      subtitle: z.string().nullable(),
      description: z.string().nullable(),
      startDate: z.string(),
      endDate: z.string(),
      isInternal: z.boolean(),
    }),
    after: z.strictObject({ version, fieldsHash: hash }),
  }),
  z.strictObject({
    kind: z.literal('appointmentCreate'),
    tool,
    placeId: id,
    fieldsHash: hash,
  }),
  z.strictObject({
    kind: z.literal('bookingCreate'),
    tool,
    placeId: id,
    fieldsHash: hash,
    startDate: z.string(),
    endDate: z.string(),
  }),
]);
const outcomeSchema = z.union([
  z.strictObject({
    kind: z.literal('wikiPageCreated'),
    guid,
    version,
  }),
  z.strictObject({
    kind: z.literal('appointmentCreated'),
    id,
    version,
  }),
  z.strictObject({
    kind: z.literal('bookingCreated'),
    id,
    version,
    statusId: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
  }),
]);
/**
 * Whether a content is an outcome, the only form of a part `after`: what
 * ChurchTools named of a new page, appointment or booking.
 *
 * @param content - A part of a snapshot.
 * @returns Whether it is an outcome.
 * @example
 * ```ts
 * isOutcome({ kind: 'appointmentCreated', id: 51, version: 0 }); // true
 * ```
 */
export const isOutcome = (
  content: SnapshotContent,
): content is SnapshotOutcome =>
  content.kind === 'wikiPageCreated' ||
  content.kind === 'appointmentCreated' ||
  content.kind === 'bookingCreated';

const recordSchema = z.strictObject({
  v: z.literal(1),
  content: z.union([stateSchema, outcomeSchema]),
});

// The first part of the additional data of every record: the version of
// the format. Tenant, instance, event, part and day follow, so that a
// record moved to another place of the store never opens there.
const label = 'ecclium/snapshot/v1';
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

const placeOf = (ctx: TenantContext) => {
  const tenantId = ownData(ctx, 'tenantId');
  const instance = ownData(ctx, 'instance');
  if (!isTenantId(tenantId) || typeof instance !== 'string') {
    throw new TypeError('The context of a snapshot is invalid.');
  }
  return { tenantId, instance };
};

const aadOf = (
  ctx: TenantContext,
  eventId: string,
  part: SnapshotPart,
  day: IsoDate,
): Uint8Array => {
  const { tenantId, instance } = placeOf(ctx);
  return infoOf([label, tenantId, instance, eventId, part, day]);
};

/** What {@link sealSnapshot} seals. */
export interface SnapshotToSeal {
  /** The ID of the audit event of the write. */
  readonly eventId: string;
  /** Which part it is: `before` for a state, `after` for an outcome. */
  readonly part: SnapshotPart;
  /** The UTC day, which picks the day key. */
  readonly day: IsoDate;
  /** What the part holds. */
  readonly content: SnapshotContent;
}

/**
 * Seals a part of a snapshot for a store.
 *
 * @param keys - The provider of keys with the day keys.
 * @param ctx - The context of the write, for tenant and instance.
 * @param snapshot - Event, part, day and content.
 * @returns The sealed record, frozen.
 * @throws {TypeError} For an event, day, part or content that does not
 *   fit, or a record longer than a store keeps.
 * @example
 * ```ts
 * const sealed = await sealSnapshot(keys, ctx, { eventId, part: 'before', day, content });
 * await store.put(ctx, sealed);
 * ```
 */
export async function sealSnapshot(
  keys: Pick<KeyProvider, 'wrap'>,
  ctx: TenantContext,
  snapshot: SnapshotToSeal,
): Promise<SealedSnapshot> {
  const { eventId, part, day, content } = snapshot;
  if (!isUuid(eventId) || !isIsoDate(day)) {
    throw new TypeError('The snapshot does not fit.');
  }
  const record = recordSchema.safeParse({ v: 1, content });
  const fitsPart =
    record.success && (part === 'after') === isOutcome(record.data.content);
  // The part is checked as a value too, for callers compiled apart.
  if (
    !record.success ||
    !fitsPart ||
    !(snapshotParts as readonly unknown[]).includes(part)
  ) {
    throw new TypeError('The snapshot does not fit.');
  }
  const aad = aadOf(ctx, eventId, part, day);
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
    const wrapped = await keys.wrap(ctx, 'snapshot', day, key);
    const sealed = `${wrapped.sealed}.${data}`;
    if (sealed.length > maxSealedSnapshotLength) {
      throw new TypeError('The snapshot is too large.');
    }
    return Object.freeze({ eventId, part, day, sealed });
  } finally {
    key.fill(0);
    plain.fill(0);
  }
}

/**
 * Opens a part of a snapshot that {@link sealSnapshot} sealed for the same
 * tenant and instance.
 *
 * @param keys - The provider of keys with the day keys.
 * @param ctx - The context, for tenant and instance.
 * @param snapshot - The sealed record from the store.
 * @returns What it holds, or undefined when its day key is gone: its
 *   retention is over.
 * @throws {Error} When the record was changed, belongs elsewhere or does
 *   not hold a part of a snapshot.
 * @example
 * ```ts
 * const content = await openSnapshot(keys, ctx, sealed);
 * if (content === undefined) report('expired');
 * ```
 */
export async function openSnapshot(
  keys: Pick<KeyProvider, 'unwrap'>,
  ctx: TenantContext,
  snapshot: SealedSnapshot,
): Promise<SnapshotContent | undefined> {
  const eventId = ownData(snapshot, 'eventId');
  const part = ownData(snapshot, 'part');
  const day = ownData(snapshot, 'day');
  const sealed = ownData(snapshot, 'sealed');
  if (
    !isUuid(eventId) ||
    (part !== 'before' && part !== 'after') ||
    !isIsoDate(day) ||
    typeof sealed !== 'string'
  ) {
    throw new Error('The snapshot does not open.');
  }
  const [wrappedKey, data, rest] = sealed.split('.');
  if (
    rest !== undefined ||
    wrappedKey === undefined ||
    data === undefined ||
    !wrappedPattern.test(wrappedKey) ||
    !dataPattern.test(data)
  ) {
    throw new Error('The snapshot does not open.');
  }
  const bytes = Buffer.from(data, 'base64url');
  if (bytes.length < nonceLength + tagLength) {
    throw new Error('The snapshot does not open.');
  }
  const aad = aadOf(ctx, eventId, part, day);
  const key = await keys.unwrap(ctx, 'snapshot', {
    purpose: 'snapshot',
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
      throw new Error('The snapshot does not open.');
    }
  } finally {
    key.fill(0);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(plain));
  } catch {
    throw new Error('The snapshot does not open.');
  } finally {
    plain.fill(0);
  }
  const record = recordSchema.safeParse(parsed);
  if (
    !record.success ||
    (part === 'after') !== isOutcome(record.data.content)
  ) {
    throw new Error('The snapshot does not open.');
  }
  return record.data.content;
}
