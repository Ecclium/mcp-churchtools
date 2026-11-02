import { describe, expect, it } from 'vitest';

import { type WriteIntentKind, writeIntentKinds } from './index.js';

// Every kind of the union, once, so that the list at run time cannot miss
// one the types know.
const everyKind = {
  wikiPageCreate: true,
  wikiPageUpdate: true,
  wikiSectionAppend: true,
  appointmentCreate: true,
  appointmentUpdate: true,
  bookingCreate: true,
  groupMemberAdd: true,
  groupMemberRemove: true,
  serviceRequest: true,
  apiOperation: true,
} satisfies Record<WriteIntentKind, true>;

describe('the contract of a write', () => {
  it('lists every kind of intent once, frozen', () => {
    expect([...writeIntentKinds].sort()).toEqual(Object.keys(everyKind).sort());
    expect(new Set(writeIntentKinds).size).toBe(writeIntentKinds.length);
    expect(Object.isFrozen(writeIntentKinds)).toBe(true);
  });

  it('lists the six writes of the core before the four of the Pro module', () => {
    expect(writeIntentKinds.slice(6)).toEqual([
      'groupMemberAdd',
      'groupMemberRemove',
      'serviceRequest',
      'apiOperation',
    ]);
  });
});
