import type {
  IsoDate,
  SealedSnapshot,
  TenantContext,
} from '@ecclium/mcp-churchtools-plugin-api';
import { createMemoryDayKeys } from '@ecclium/mcp-churchtools-testkit';
import { describe, expect, it } from 'vitest';

import { contentHashOf } from '../write/plan-hash.js';
import {
  openSnapshot,
  type SnapshotContent,
  sealSnapshot,
  type SnapshotToSeal,
} from './seal.js';

// Snapshots are sealed with day keys in memory from testkit; the day keys
// of the files are checked against the same promises in keys/.

const contextOf = (
  tenantId = 'demo-tenant',
  instance = 'https://example.church.tools',
): TenantContext => ({ tenantId, instance }) as unknown as TenantContext;

const ctx = contextOf();
const eventId = '11111111-2222-4333-8444-555555555555';
const day = '2026-11-03' as IsoDate;
const guid = '00000000-0000-4000-8000-0000000000ab';

const state: SnapshotContent = {
  kind: 'wikiPageText',
  tool: 'ct_wiki_page_update',
  categoryId: 12,
  guid,
  before: { version: 3, text: '# Plan\nmit max.mustermann@example.org\n' },
  after: { version: 4, textHash: contentHashOf(['# Neu\n']) },
};
const created: SnapshotContent = {
  kind: 'wikiPageCreated',
  guid,
  version: 1,
};

const before = (content: SnapshotContent = state): SnapshotToSeal => ({
  eventId,
  part: 'before',
  day,
  content,
});

describe('sealSnapshot and openSnapshot', () => {
  it('open what they sealed, and the store sees no text of the page', async () => {
    const keys = createMemoryDayKeys();
    const sealed = await sealSnapshot(keys, ctx, before());
    expect(sealed).toMatchObject({ eventId, part: 'before', day });
    expect(sealed.sealed).toMatch(/^[A-Za-z0-9_-]{80}\.[A-Za-z0-9_-]+$/);
    expect(sealed.sealed).not.toContain('Plan');
    expect(Object.isFrozen(sealed)).toBe(true);
    expect(await openSnapshot(keys, ctx, sealed)).toEqual(state);
    const after = await sealSnapshot(keys, ctx, {
      eventId,
      part: 'after',
      day,
      content: created,
    });
    expect(await openSnapshot(keys, ctx, after)).toEqual(created);
  });

  // The parts of appointments and bookings (ADR 0072).
  it.each<[string, SnapshotContent]>([
    [
      'the fields of an appointment',
      {
        kind: 'appointmentFields',
        tool: 'ct_appointments_update',
        calendarId: 8,
        appointmentId: 21,
        before: {
          version: 2,
          title: 'Gottesdienst',
          subtitle: null,
          description: 'Mit Taufe',
          startDate: '2026-11-08T09:00:00Z',
          endDate: '2026-11-08T10:00:00Z',
          isInternal: false,
        },
        after: { version: 3, fieldsHash: contentHashOf(['a']) },
      },
    ],
    [
      'a new booking',
      {
        kind: 'bookingCreate',
        tool: 'ct_bookings_create',
        placeId: 13,
        fieldsHash: contentHashOf(['b']),
        startDate: '2026-11-08T09:00:00Z',
        endDate: '2026-11-08T10:00:00Z',
      },
    ],
    [
      'a new appointment',
      {
        kind: 'appointmentCreate',
        tool: 'ct_appointments_create',
        placeId: 8,
        fieldsHash: contentHashOf(['c']),
      },
    ],
    [
      'a new appointment named',
      { kind: 'appointmentCreated', id: 31, version: 0 },
    ],
    [
      'a new booking named',
      { kind: 'bookingCreated', id: 51, version: 1, statusId: 1 },
    ],
  ])('open what they sealed of %s', async (_, content) => {
    const keys = createMemoryDayKeys();
    const part = content.kind.endsWith('Created') ? 'after' : 'before';
    const sealed = await sealSnapshot(keys, ctx, { ...before(content), part });
    expect(await openSnapshot(keys, ctx, sealed)).toEqual(content);
    // An outcome is only a part after, a state only a part before.
    await expect(
      sealSnapshot(keys, ctx, {
        ...before(content),
        part: part === 'after' ? 'before' : 'after',
      }),
    ).rejects.toThrow(TypeError);
  });

  it('seal the same content twice into two different records', async () => {
    const keys = createMemoryDayKeys();
    const first = await sealSnapshot(keys, ctx, before());
    const second = await sealSnapshot(keys, ctx, before());
    expect(first.sealed).not.toBe(second.sealed);
  });

  it('give nothing once the day key of the day is destroyed', async () => {
    const keys = createMemoryDayKeys();
    const sealed = await sealSnapshot(keys, ctx, before());
    expect(await keys.destroyBefore('snapshot', '2026-11-04' as IsoDate)).toBe(
      1,
    );
    expect(await openSnapshot(keys, ctx, sealed)).toBeUndefined();
  });

  it('never open a record moved to another tenant, instance, event, part or day', async () => {
    const keys = createMemoryDayKeys();
    const sealed = await sealSnapshot(keys, ctx, before());
    await sealSnapshot(keys, contextOf('other-tenant'), before());
    // The day key of the other tenant does not open the key of the record.
    await expect(
      openSnapshot(keys, contextOf('other-tenant'), sealed),
    ).rejects.toThrow();
    await expect(
      openSnapshot(
        keys,
        contextOf('demo-tenant', 'https://other.example'),
        sealed,
      ),
    ).rejects.toThrow('does not open');
    for (const moved of [
      { ...sealed, eventId: '11111111-2222-4333-8444-555555555556' },
      { ...sealed, part: 'after' as const },
    ]) {
      await expect(openSnapshot(keys, ctx, moved)).rejects.toThrow(
        'does not open',
      );
    }
    await sealSnapshot(keys, ctx, {
      ...before(),
      day: '2026-11-04' as IsoDate,
    });
    await expect(
      openSnapshot(keys, ctx, { ...sealed, day: '2026-11-04' as IsoDate }),
    ).rejects.toThrow();
  });

  it('refuse a record that was changed or does not have the form of one', async () => {
    const keys = createMemoryDayKeys();
    const sealed = await sealSnapshot(keys, ctx, before());
    const last = sealed.sealed.at(-1) === 'A' ? 'B' : 'A';
    const forms: unknown[] = [
      { ...sealed, sealed: `${sealed.sealed.slice(0, -1)}${last}` },
      { ...sealed, sealed: `${sealed.sealed}.x` },
      { ...sealed, sealed: sealed.sealed.replace('.', '') },
      { ...sealed, sealed: `${sealed.sealed.slice(0, 81)}AAAA` },
      { ...sealed, sealed: `+${sealed.sealed.slice(1)}` },
      { ...sealed, sealed: `${sealed.sealed.slice(0, 81)}=` },
      { ...sealed, sealed: 5 },
      { ...sealed, eventId: 'not-an-id' },
      { ...sealed, part: 'middle' },
      { ...sealed, day: 'today' },
      new Proxy(sealed, {}),
    ];
    for (const form of forms) {
      await expect(
        openSnapshot(keys, ctx, form as SealedSnapshot),
      ).rejects.toThrow();
    }
  });

  it('refuse a record that opens but holds no part of a snapshot', async () => {
    // A record sealed with the same keys as a snapshot, but with content
    // of another form: it opens, and the check after opening refuses it.
    const keys = createMemoryDayKeys();
    const sealed = await sealSnapshot(keys, ctx, before());
    const { createCipheriv } = await import('node:crypto');
    const { infoOf } = await import('../keys/index.js');
    const key = new Uint8Array(32);
    const wrapped = await keys.wrap(ctx, 'snapshot', day, key);
    const sealWith = (plain: string): string => {
      const nonce = new Uint8Array(12);
      const cipher = createCipheriv('aes-256-gcm', key, nonce, {
        authTagLength: 16,
      });
      cipher.setAAD(
        infoOf([
          'ecclium/snapshot/v1',
          'demo-tenant',
          'https://example.church.tools',
          eventId,
          'before',
          day,
        ]),
      );
      return `${wrapped.sealed}.${Buffer.concat([
        nonce,
        cipher.update(Buffer.from(plain)),
        cipher.final(),
        cipher.getAuthTag(),
      ]).toString('base64url')}`;
    };
    for (const plain of [
      'not json',
      'ÿ',
      JSON.stringify({ v: 2, content: state }),
      JSON.stringify({ v: 1, content: created }),
    ]) {
      await expect(
        openSnapshot(keys, ctx, { ...sealed, sealed: sealWith(plain) }),
      ).rejects.toThrow('does not open');
    }
    expect(
      await openSnapshot(keys, ctx, {
        ...sealed,
        sealed: sealWith(JSON.stringify({ v: 1, content: state })),
      }),
    ).toEqual(state);
  });

  it('refuse to seal what does not fit', async () => {
    const keys = createMemoryDayKeys();
    const forms: SnapshotToSeal[] = [
      { ...before(), eventId: 'NOT-A-UUID' },
      { ...before(), day: '2026-02-30' as IsoDate },
      { ...before(), part: 'after' },
      { eventId, part: 'before', day, content: created },
      { ...before(), part: 'middle' as 'before' },
      before({ ...state, tool: 'Not A Tool' }),
      before({ ...state, tool: 'wiki_page_update' }),
      before({ ...state, guid: '-'.repeat(36) }),
      before({ ...state, categoryId: 0 }),
      before({ ...state, extra: 1 } as unknown as SnapshotContent),
    ];
    for (const form of forms) {
      await expect(sealSnapshot(keys, ctx, form)).rejects.toThrow(TypeError);
    }
    await expect(
      sealSnapshot(
        keys,
        { tenantId: 'demo-tenant' } as unknown as TenantContext,
        before(),
      ),
    ).rejects.toThrow(TypeError);
    await expect(
      sealSnapshot(keys, new Proxy(ctx, {}), before()),
    ).rejects.toThrow(TypeError);
  });

  it('refuse a snapshot larger than a store keeps', async () => {
    const keys = createMemoryDayKeys();
    const large = before({
      ...state,
      before: { version: 3, text: 'x'.repeat(13 * 1024 * 1024) },
    });
    await expect(sealSnapshot(keys, ctx, large)).rejects.toThrow(
      'The snapshot is too large.',
    );
  });
});
