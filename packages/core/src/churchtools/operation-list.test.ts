import { describe, expect, it } from 'vitest';

import {
  classification,
  findReadableOperation,
  generatedOperations,
} from './catalog/index.js';
import { listReadableOperations } from './operation-list.js';

// The list of the escape hatch for the plugin API (ADR 0067): exactly the
// operations a read would not refuse, with the parameters the core sends.

describe('listReadableOperations', () => {
  const listed = listReadableOperations();

  it('lists exactly the operations a read would not refuse, sorted and frozen', () => {
    const readable = generatedOperations
      .map((operation) => operation.operationId)
      .filter((id) => findReadableOperation(id).ok)
      .sort();
    expect(listed.map((operation) => operation.operationId)).toEqual(readable);
    const allowedIds = Object.entries(classification)
      .filter(([, entry]) => entry.allowed)
      .map(([id]) => id)
      .sort();
    expect(readable).toEqual(allowedIds);
    expect(Object.isFrozen(listed)).toBe(true);
    for (const operation of listed) {
      expect(Object.isFrozen(operation)).toBe(true);
      expect(Object.isFrozen(operation.pathParameters)).toBe(true);
      expect(Object.isFrozen(operation.queryParameters)).toBe(true);
    }
  });

  it('names the path parameters with their safe kind, each required', () => {
    const group = listed.find(
      (operation) => operation.operationId === 'get-groups-groupId',
    );
    expect(group?.path).toBe('/api/groups/{groupId}');
    expect(group?.sensitivity).toBe('special');
    expect(group?.pathParameters).toEqual([
      { name: 'groupId', kind: 'integer', required: true, list: false },
    ]);
    // The classification gives the wiki page its GUID (ADR 0067).
    const page = listed.find(
      (operation) =>
        operation.operationId === 'get-wiki-categories-id-pages-identifier',
    );
    expect(page?.pathParameters.map((parameter) => parameter.kind)).toContain(
      'guid',
    );
  });

  it('leaves out every parameter of the query the core never sends', () => {
    const persons = listed.find(
      (operation) => operation.operationId === 'get-persons',
    );
    const names = persons?.queryParameters.map((parameter) => parameter.name);
    expect(names).not.toContain('birthday_after');
    expect(names).not.toContain('birthday_before');
    expect(names?.length).toBeGreaterThan(0);
    for (const operation of listed) {
      for (const parameter of operation.queryParameters) {
        expect(parameter.kind, operation.operationId).not.toBe('unsupported');
      }
    }
  });

  it('lists no excluded operation', () => {
    const ids = new Set(listed.map((operation) => operation.operationId));
    for (const id of [
      'get-persons-birthdays',
      'get-csrftoken',
      'get-persons-id-logintoken',
    ]) {
      expect(ids.has(id), id).toBe(false);
    }
  });
});
