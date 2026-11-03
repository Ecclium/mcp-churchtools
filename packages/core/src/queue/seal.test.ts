import type {
  IsoDate,
  SealedQueueEntry,
  TenantContext,
  WriteIntent,
} from '@ecclium/mcp-churchtools-plugin-api';
import { createMemoryDayKeys } from '@ecclium/mcp-churchtools-testkit';
import { describe, expect, it } from 'vitest';

import {
  openQueueEntry,
  type QueueEntryContent,
  type QueueEntryToSeal,
  queueReasons,
  sealQueueEntry,
} from './seal.js';

// Entries are sealed with day keys in memory from testkit; the day keys of
// the files are checked against the same promises in keys/.

const contextOf = (
  tenantId = 'demo-tenant',
  instance = 'https://example.church.tools',
): TenantContext => ({ tenantId, instance }) as unknown as TenantContext;

const ctx = contextOf();
const id = '11111111-2222-4333-8444-555555555555';
const day = '2026-11-03' as IsoDate;
const guid = '00000000-0000-4000-8000-0000000000ab';

const intent: WriteIntent = {
  kind: 'wikiSectionAppend',
  categoryId: 12,
  guid,
  section: '## Nachtrag\nmit max.mustermann@example.org\n',
  baseVersion: 3,
};

const content: QueueEntryContent = {
  tool: 'ct_wiki_page_append_section',
  origin: 'core',
  toolMeta: {
    sensitivity: 'personal',
    unattended: 'policy',
    reversible: 'snapshot',
  },
  actor: { kind: 'service', id: 'stdio:local-stdio' },
  intent,
  planHash: 'a'.repeat(64),
  target: { kind: 'wiki_page', key: `12/${guid}` },
  summary:
    'An die Seite «Plan» in der Kategorie 12 einen Abschnitt mit 2 Zeilen anhängen.',
  diff: ['@@ -1,1 +1,4 @@', ' # Plan', '+', '+## Nachtrag'],
  reason: 'no_entry',
  queuedAt: Date.UTC(2026, 10, 3, 17),
};

const toSeal = (value: QueueEntryContent = content): QueueEntryToSeal => ({
  id,
  day,
  content: value,
});

describe('the reasons of the queue', () => {
  it('name the five of the policy first and three of the way, frozen', () => {
    expect(queueReasons).toEqual([
      'queue_only',
      'no_entry',
      'name_changed',
      'limit_reached',
      'count_unavailable',
      'setting',
      'no_question',
      'too_long',
    ]);
    expect(Object.isFrozen(queueReasons)).toBe(true);
  });
});

describe('sealQueueEntry and openQueueEntry', () => {
  it('open what they sealed, and the store sees no text of the write', async () => {
    const keys = createMemoryDayKeys();
    const sealed = await sealQueueEntry(keys, ctx, toSeal());
    expect(sealed).toMatchObject({ id, day });
    expect(sealed.sealed).toMatch(/^[A-Za-z0-9_-]{80}\.[A-Za-z0-9_-]+$/);
    expect(sealed.sealed).not.toContain('Nachtrag');
    expect(Object.isFrozen(sealed)).toBe(true);
    expect(await openQueueEntry(keys, ctx, sealed)).toEqual(content);
    // A new page with its whole title, and a plan without reversible.
    const create: QueueEntryContent = {
      ...content,
      intent: { kind: 'wikiPageCreate', categoryId: 12, title: 'T', text: 'x' },
      toolMeta: { sensitivity: 'none', unattended: 'never' },
      title: 'T',
      origin: 'plugin',
      reason: 'too_long',
    };
    expect(
      await openQueueEntry(
        keys,
        ctx,
        await sealQueueEntry(keys, ctx, toSeal(create)),
      ),
    ).toEqual(create);
  });

  it('seal the same content twice into two different entries', async () => {
    const keys = createMemoryDayKeys();
    const first = await sealQueueEntry(keys, ctx, toSeal());
    const second = await sealQueueEntry(keys, ctx, toSeal());
    expect(first.sealed).not.toBe(second.sealed);
  });

  it('give nothing once the day key queue of the day is destroyed, and none of the snapshots counts', async () => {
    const keys = createMemoryDayKeys();
    const sealed = await sealQueueEntry(keys, ctx, toSeal());
    expect(await keys.destroyBefore('snapshot', '2026-11-04' as IsoDate)).toBe(
      0,
    );
    expect(await openQueueEntry(keys, ctx, sealed)).toEqual(content);
    expect(await keys.destroyBefore('queue', '2026-11-04' as IsoDate)).toBe(1);
    expect(await openQueueEntry(keys, ctx, sealed)).toBeUndefined();
  });

  it('never open an entry moved to another tenant, instance, ID or day', async () => {
    const keys = createMemoryDayKeys();
    const sealed = await sealQueueEntry(keys, ctx, toSeal());
    await sealQueueEntry(keys, contextOf('other-tenant'), toSeal());
    await expect(
      openQueueEntry(keys, contextOf('other-tenant'), sealed),
    ).rejects.toThrow();
    await expect(
      openQueueEntry(
        keys,
        contextOf('demo-tenant', 'https://other.example'),
        sealed,
      ),
    ).rejects.toThrow('does not open');
    await expect(
      openQueueEntry(keys, ctx, {
        ...sealed,
        id: '11111111-2222-4333-8444-555555555556',
      }),
    ).rejects.toThrow('does not open');
    await sealQueueEntry(keys, ctx, {
      ...toSeal(),
      day: '2026-11-04' as IsoDate,
    });
    await expect(
      openQueueEntry(keys, ctx, { ...sealed, day: '2026-11-04' as IsoDate }),
    ).rejects.toThrow();
  });

  it('refuse an entry that was changed or does not have the form of one', async () => {
    const keys = createMemoryDayKeys();
    const sealed = await sealQueueEntry(keys, ctx, toSeal());
    // A sign inside the data, all of whose bits count: the last sign of
    // base64url may carry only bits of padding.
    const at = 100;
    const other = sealed.sealed[at] === 'A' ? 'B' : 'A';
    const forms: unknown[] = [
      {
        ...sealed,
        sealed: `${sealed.sealed.slice(0, at)}${other}${sealed.sealed.slice(at + 1)}`,
      },
      { ...sealed, sealed: `${sealed.sealed}.x` },
      { ...sealed, sealed: sealed.sealed.replace('.', '') },
      { ...sealed, sealed: `${sealed.sealed.slice(0, 81)}AAAA` },
      { ...sealed, sealed: `+${sealed.sealed.slice(1)}` },
      { ...sealed, sealed: `${sealed.sealed.slice(0, 81)}=` },
      { ...sealed, sealed: 5 },
      { ...sealed, id: 'not-an-id' },
      { ...sealed, day: 'today' },
      new Proxy(sealed, {}),
    ];
    for (const form of forms) {
      await expect(
        openQueueEntry(keys, ctx, form as SealedQueueEntry),
      ).rejects.toThrow();
    }
  });

  it('refuse an entry that opens but holds no entry of the queue', async () => {
    // An entry sealed with the same keys, but with content of another
    // form: it opens, and the check after opening refuses it.
    const keys = createMemoryDayKeys();
    const sealed = await sealQueueEntry(keys, ctx, toSeal());
    const { createCipheriv } = await import('node:crypto');
    const { infoOf } = await import('../keys/index.js');
    const key = new Uint8Array(32);
    const wrapped = await keys.wrap(ctx, 'queue', day, key);
    const sealWith = (plain: string): string => {
      const nonce = new Uint8Array(12);
      const cipher = createCipheriv('aes-256-gcm', key, nonce, {
        authTagLength: 16,
      });
      cipher.setAAD(
        infoOf([
          'ecclium/queue/v1',
          'demo-tenant',
          'https://example.church.tools',
          id,
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
      JSON.stringify({ v: 2, content }),
      JSON.stringify({ v: 1, content: { ...content, reason: 'later' } }),
    ]) {
      await expect(
        openQueueEntry(keys, ctx, { ...sealed, sealed: sealWith(plain) }),
      ).rejects.toThrow('does not open');
    }
    expect(
      await openQueueEntry(keys, ctx, {
        ...sealed,
        sealed: sealWith(JSON.stringify({ v: 1, content })),
      }),
    ).toEqual(content);
  });

  it('refuse to seal what does not fit', async () => {
    const keys = createMemoryDayKeys();
    const forms: QueueEntryToSeal[] = [
      { ...toSeal(), id: 'NOT-A-UUID' },
      { ...toSeal(), day: '2026-02-30' as IsoDate },
      toSeal({ ...content, tool: 'Not A Tool' }),
      toSeal({ ...content, origin: 'elsewhere' as 'core' }),
      toSeal({
        ...content,
        toolMeta: { ...content.toolMeta, sensitivity: 'secret' as 'none' },
      }),
      toSeal({ ...content, actor: { kind: 'service', id: 'Max Mustermann' } }),
      toSeal({ ...content, intent: { kind: 'wikiPageDelete' } as never }),
      toSeal({ ...content, intent: { categoryId: 12 } as never }),
      toSeal({ ...content, planHash: 'A'.repeat(64) }),
      toSeal({
        ...content,
        target: { kind: 'person' as 'wiki_page', key: '1' },
      }),
      toSeal({ ...content, summary: '' }),
      toSeal({ ...content, reason: 'later' as 'setting' }),
      toSeal({ ...content, queuedAt: -1 }),
      toSeal({ ...content, extra: 1 } as unknown as QueueEntryContent),
    ];
    for (const form of forms) {
      await expect(sealQueueEntry(keys, ctx, form)).rejects.toThrow(TypeError);
    }
    await expect(
      sealQueueEntry(
        keys,
        { tenantId: 'demo-tenant' } as unknown as TenantContext,
        toSeal(),
      ),
    ).rejects.toThrow(TypeError);
    await expect(
      sealQueueEntry(keys, new Proxy(ctx, {}), toSeal()),
    ).rejects.toThrow(TypeError);
  });

  it('refuse an entry larger than a store keeps', async () => {
    const keys = createMemoryDayKeys();
    const large = toSeal({
      ...content,
      diff: Array.from({ length: 220 }, () => `+${'x'.repeat(60_000)}`),
    });
    await expect(sealQueueEntry(keys, ctx, large)).rejects.toThrow(
      'The entry is too large.',
    );
  });
});
