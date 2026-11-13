import { describe, expect, it } from 'vitest';

import { grantedOf } from './accounts.js';

// The rights as ct_whoami gives them, turned back into the rights of the
// client for the chain of the write guard (ADR 0032).

const known = (modules: unknown) => ({
  id: 7,
  rights: { status: 'known', modules },
});

describe('grantedOf', () => {
  it('turns a right without IDs into true and one with IDs into its IDs', () => {
    const read = grantedOf(
      known([
        {
          module: 'churchwiki',
          rights: [
            { right: 'view' },
            { right: 'edit category', ids: [7, 12], idCount: 2 },
          ],
        },
        { module: 'churchcal', rights: [{ right: 'view' }] },
      ]),
    );
    expect(read).toEqual({
      kind: 'read',
      granted: {
        churchwiki: { view: true, 'edit category': [7, 12] },
        churchcal: { view: true },
      },
      cut: new Set(),
    });
    expect(Object.isFrozen(read)).toBe(true);
  });

  it('notes a list ct_whoami cut short', () => {
    const read = grantedOf(
      known([
        {
          module: 'churchwiki',
          rights: [
            {
              right: 'edit category',
              ids: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
              idCount: 12,
            },
          ],
        },
      ]),
    );
    expect(read?.kind === 'read' && [...read.cut]).toEqual([
      'churchwiki\u0000edit category',
    ]);
  });

  it('keeps a name such as __proto__ as an own property', () => {
    const read = grantedOf(
      known([{ module: '__proto__', rights: [{ right: 'view' }] }]),
    );
    expect(
      read?.kind === 'read' && Object.hasOwn(read.granted, '__proto__'),
    ).toBe(true);
  });

  it('gives unknown for the status unknown', () => {
    expect(grantedOf({ rights: { status: 'unknown', modules: null } })).toEqual(
      { kind: 'unknown' },
    );
  });

  it.each([
    undefined,
    null,
    {},
    { rights: { status: 'known' } },
    { rights: { status: 'other', modules: [] } },
    known([{ module: 7, rights: [] }]),
    known([{ module: 'churchwiki' }]),
    known([{ module: 'churchwiki', rights: [{ right: 7 }] }]),
    known([{ module: 'churchwiki', rights: [{ right: 'view', ids: 'x' }] }]),
    known([{ module: 'churchwiki', rights: [{ right: 'view', ids: [1.5] }] }]),
    Object.create({ rights: { status: 'known', modules: [] } }) as unknown,
  ])('gives nothing for any other form, such as %j', (data) => {
    expect(grantedOf(data)).toBeUndefined();
  });
});
