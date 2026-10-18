import type {
  Exposure,
  ReplayGuard,
  Reversible,
  Tier,
  ToolMeta,
} from '@ecclium/mcp-churchtools-plugin-api';
import type { ToolAnnotations } from '@modelcontextprotocol/server';
import { describe, expect, expectTypeOf, it } from 'vitest';

import { checkMeta, toolDomains } from '../registry/meta.js';
import { deriveAnnotations, type ToolHints } from './annotations.js';

const exposures: readonly Exposure[] = [
  { sensitivity: 'special', unattended: 'never' },
  { sensitivity: 'personal', unattended: 'never' },
  { sensitivity: 'personal', unattended: 'policy' },
  { sensitivity: 'none', unattended: 'never' },
  { sensitivity: 'none', unattended: 'policy' },
];
const tiers: readonly Tier[] = ['free', 'pro'];
const reversibles: readonly Reversible[] = ['yes', 'no', 'snapshot'];
const replayGuards: readonly ReplayGuard[] = ['baseVersion', 'marker', 'nonce'];
const rightLists = [[], [{ module: 'churchdb', right: 'view alldata' }]];

// Every combination of metadata the registry accepts, with the copy the
// registry keeps, which is what the mount reads.
const combinations = (): ToolMeta[] => {
  const all: unknown[] = [];
  for (const domain of toolDomains) {
    for (const exposure of exposures) {
      for (const tier of tiers) {
        for (const routineStable of [false, true]) {
          for (const requiredRights of rightLists) {
            const common = {
              domain,
              requiredRights,
              tier,
              routineStable,
              ...exposure,
            };
            all.push({ ...common, capability: 'read' });
            for (const reversible of reversibles) {
              for (const replayGuard of replayGuards) {
                all.push({
                  ...common,
                  capability: 'write',
                  reversible,
                  replayGuard,
                });
              }
            }
          }
        }
      }
    }
  }
  return all.map((value) => {
    const checked = checkMeta(value);
    if (checked === undefined) throw new Error('the registry refused a case');
    return checked;
  });
};

const read: ToolHints = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};
const reversibleWrite: ToolHints = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};
const destructiveWrite: ToolHints = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

const expected = (meta: ToolMeta): ToolHints => {
  if (meta.capability === 'read') return read;
  return meta.reversible === 'yes' ? reversibleWrite : destructiveWrite;
};

describe('deriveAnnotations', () => {
  it('sets all four hints from the metadata, for every combination', () => {
    const all = combinations();
    // 13 domains, 5 exposures, 2 tiers, 2 flags and 2 lists of rights, each
    // once as a read and in 9 forms as a write.
    expect(all).toHaveLength(13 * 5 * 2 * 2 * 2 * 10);
    for (const meta of all) {
      expect(deriveAnnotations(meta), JSON.stringify(meta)).toEqual(
        expected(meta),
      );
    }
  });

  it('marks a read as read only, not destructive and idempotent', () => {
    const [meta] = combinations();
    if (meta?.capability !== 'read') throw new Error('expected a read first');
    expect(deriveAnnotations(meta)).toEqual(read);
  });

  it('marks a write as destructive unless it can be undone, and never as idempotent', () => {
    const writes = combinations().filter((meta) => meta.capability === 'write');
    for (const reversible of reversibles) {
      const hints = writes
        .filter((meta) => meta.reversible === reversible)
        .map((meta) => deriveAnnotations(meta));
      expect(hints.length).toBeGreaterThan(0);
      for (const hint of hints) {
        expect(hint.readOnlyHint).toBe(false);
        expect(hint.destructiveHint).toBe(reversible !== 'yes');
        expect(hint.idempotentHint).toBe(false);
      }
    }
  });

  it('marks every tool as reaching an open world', () => {
    for (const meta of combinations()) {
      expect(deriveAnnotations(meta).openWorldHint).toBe(true);
    }
  });

  it('returns the hints frozen, without prototype and as plain JSON', () => {
    for (const meta of combinations()) {
      const hints = deriveAnnotations(meta);
      expect(Object.isFrozen(hints)).toBe(true);
      expect(Object.getPrototypeOf(hints)).toBeNull();
      expect(Object.keys(hints).sort()).toEqual([
        'destructiveHint',
        'idempotentHint',
        'openWorldHint',
        'readOnlyHint',
      ]);
    }
    const [first] = combinations();
    if (first === undefined) throw new Error('no combination');
    expect(JSON.stringify(deriveAnnotations(first))).toBe(
      '{"readOnlyHint":true,"destructiveHint":false,"idempotentHint":true,"openWorldHint":true}',
    );
  });

  it('shares one object among tools with the same hints', () => {
    const all = combinations();
    const distinct = new Set(all.map((meta) => deriveAnnotations(meta)));
    expect(distinct.size).toBe(3);
  });

  it('takes a value outside the types as the more cautious one', () => {
    const outside = (value: Record<string, unknown>): ToolHints =>
      deriveAnnotations(value as unknown as ToolMeta);
    expect(outside({ capability: 'Read' })).toEqual(destructiveWrite);
    expect(outside({ capability: undefined })).toEqual(destructiveWrite);
    expect(outside({ capability: 'write' })).toEqual(destructiveWrite);
    expect(outside({ capability: 'write', reversible: 'Yes' })).toEqual(
      destructiveWrite,
    );
    expect(outside({ capability: 'write', reversible: true })).toEqual(
      destructiveWrite,
    );
  });

  it('fits the annotations of MCP, with each hint a boolean', () => {
    expectTypeOf<ToolHints>().toExtend<ToolAnnotations>();
    expectTypeOf<ToolHints['readOnlyHint']>().toEqualTypeOf<boolean>();
    expectTypeOf<ToolHints['destructiveHint']>().toEqualTypeOf<boolean>();
    expectTypeOf<ToolHints['idempotentHint']>().toEqualTypeOf<boolean>();
    expectTypeOf<ToolHints['openWorldHint']>().toEqualTypeOf<boolean>();
  });
});
