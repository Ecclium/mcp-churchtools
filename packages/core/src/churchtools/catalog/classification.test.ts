import { describe, expect, it } from 'vitest';

import {
  classification,
  findReadableOperation,
  generatedOperations,
  isFixedExclusion,
} from './index.js';
import { exclusionReasons } from './types.js';

// The classification by hand against the generated part (ADR 0067): every
// operation has exactly one entry, every allowed one is readable, and what
// a fixed rule or the facts exclude stays excluded whatever the entry says.

const ids = generatedOperations.map((operation) => operation.operationId);
const entryOf = (operationId: string) =>
  Object.hasOwn(classification, operationId)
    ? classification[operationId]
    : undefined;

describe('the classification of the core', () => {
  it('has exactly one entry for every operation of the generated part', () => {
    expect(new Set(ids).size).toBe(ids.length);
    expect(Object.keys(classification).sort()).toEqual([...ids].sort());
  });

  it('makes every allowed operation readable and only GET operations', () => {
    for (const operation of generatedOperations) {
      expect(operation.method).toBe('get');
      if (entryOf(operation.operationId)?.allowed !== true) continue;
      const found = findReadableOperation(operation.operationId);
      expect(found, operation.operationId).toMatchObject({ ok: true });
    }
  });

  it('allows nothing a fixed rule excludes, nothing deprecated and only answers in JSON', () => {
    for (const operation of generatedOperations) {
      const entry = entryOf(operation.operationId);
      if (
        isFixedExclusion(operation.path) ||
        operation.deprecated ||
        !operation.json
      ) {
        expect(entry?.allowed, operation.operationId).toBe(false);
      }
    }
  });

  it('gives the reasons media and deprecated only where the facts say so', () => {
    for (const operation of generatedOperations) {
      const entry = entryOf(operation.operationId);
      if (entry?.allowed !== false) continue;
      expect(exclusionReasons).toContain(entry.reason);
      if (entry.reason === 'media') expect(operation.json).toBe(false);
      if (entry.reason === 'deprecated') {
        expect(operation.deprecated).toBe(true);
      }
    }
  });

  it.each([
    ['get-csrftoken', 'csrf'],
    ['get-persons-id-logintoken', 'secret'],
    ['get-persons-id-loginstring', 'secret'],
    ['get-persons-id-settings-twofactor', 'secret'],
    ['get-persons-id-settings', 'system'],
    ['get-config', 'system'],
    ['get-finance-accounts', 'finance'],
    ['get-logs', 'log'],
    ['get-persons-personId-information', 'file'],
    ['get-persons-personId-followups', 'care'],
    ['get-notes', 'care'],
    ['get-persons-personId-absences', 'care'],
    ['get-posts', 'communication'],
    ['get-chat', 'communication'],
    ['get-campuses', 'scope'],
    ['get-persons-duplicates', 'scope'],
  ])('excludes %s as %s', (operationId, reason) => {
    expect(entryOf(operationId)).toEqual({ allowed: false, reason });
    expect(findReadableOperation(operationId)).toEqual({ ok: false, reason });
  });

  it.each([
    ['get-persons-id', 'special'],
    ['get-groups-id-members', 'special'],
    ['get-permissions-global', 'special'],
    ['get-search', 'special'],
    ['get-whoami', 'personal'],
    ['get-events', 'personal'],
    ['get-wiki-categories-id-pages-identifier', 'personal'],
    ['get-group-grouptypes', 'none'],
    ['get-songs', 'none'],
  ])('allows %s with the sensitivity %s', (operationId, sensitivity) => {
    const found = findReadableOperation(operationId);
    expect(found).toMatchObject({ ok: true, operation: { sensitivity } });
  });

  it('reads the GUID of a wiki page and the IDs the document types wrongly', () => {
    const page = findReadableOperation(
      'get-wiki-categories-id-pages-identifier',
    );
    expect(page.ok && page.operation.pathParameters).toEqual([
      { name: 'wikiCategoryId', kind: 'integer' },
      { name: 'identifier', kind: 'guid' },
    ]);
    for (const operationId of [
      'get-groups-groupId-parents',
      'get-groups-id-roles',
    ]) {
      const found = findReadableOperation(operationId);
      expect(found.ok && found.operation.pathParameters, operationId).toEqual([
        { name: 'groupId', kind: 'integer' },
      ]);
    }
  });

  it('knows no operation outside the generated part', () => {
    expect(findReadableOperation('post-persons')).toEqual({
      ok: false,
      reason: 'unknown',
    });
  });
});
