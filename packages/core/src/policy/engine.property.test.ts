import type { WriteTargetKind } from '@ecclium/mcp-churchtools-plugin-api';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { checkPolicy, targetKeyOf } from './check.js';
import { judgeMatch, matchPolicy, type PolicyRequest } from './engine.js';
import type { InteractiveTarget, Policy } from './schema.js';

// Generated policies and writes (ADR 0070): the rules of the engine hold
// for every one, not only for the examples of engine.test.ts. IDs come
// from small ranges, so that writes often meet an entry.

const guids = [
  '0000000a-0000-4000-8000-000000000001',
  '0000000b-0000-4000-8000-000000000002',
] as const;
const tools = ['ct_tool_a', 'ct_tool_b', 'ct_tool_c'] as const;

const id = fc.integer({ min: 1, max: 3 });

// One name per named thing, so that no generated policy names one twice:
// a page by its GUID, as the check of the policy does.
const target: fc.Arbitrary<InteractiveTarget> = fc.oneof(
  id.map((value): InteractiveTarget => ({
    kind: 'wiki_category',
    id: value,
    name: `Kategorie ${String(value)}`,
  })),
  fc
    .tuple(id, fc.constantFrom(...guids))
    .map(([categoryId, guid]): InteractiveTarget => ({
      kind: 'wiki_page',
      categoryId,
      guid,
      name: `Seite ${guid}`,
    })),
  fc
    .tuple(fc.constantFrom('calendar', 'resource', 'group'), id)
    .map(([kind, value]): InteractiveTarget => ({
      kind,
      id: value,
      name: `${kind} ${String(value)}`,
    })),
  fc.tuple(id, id).map(([event, service]): InteractiveTarget => ({
    kind: 'service',
    event: { id: event, name: `Event ${String(event)}` },
    service: { id: service, name: `Dienst ${String(service)}` },
  })),
);

const policy: fc.Arbitrary<Policy> = fc
  .uniqueArray(
    fc.record({
      target,
      tools: fc.uniqueArray(fc.constantFrom(...tools), {
        minLength: 1,
        maxLength: 3,
      }),
      maxPerDay: fc.integer({ min: 1, max: 5 }),
    }),
    { maxLength: 8, selector: (entry) => targetKeyOf(entry.target) },
  )
  .map((targets) => {
    const result = checkPolicy({
      schema: 'policy.v1',
      interactive: { targets },
    });
    if (!result.ok) throw new Error(`generated policy refused: ${result.code}`);
    return result.policy;
  });

const kinds: readonly WriteTargetKind[] = [
  'wiki_category',
  'wiki_page',
  'calendar',
  'appointment',
  'resource',
  'group',
  'service',
];

const request: fc.Arbitrary<PolicyRequest> = fc
  .record({
    mode: fc.constantFrom('interactive' as const),
    tool: fc.constantFrom(...tools),
    kind: fc.constantFrom(...kinds),
    first: id,
    second: fc.oneof(id.map(String), fc.constantFrom(...guids)),
    alwaysQueue: fc.boolean(),
  })
  .map(({ kind, first, second, ...rest }) => ({
    ...rest,
    target: {
      kind,
      key:
        kind === 'wiki_page' || kind === 'appointment' || kind === 'service'
          ? `${String(first)}/${second}`
          : String(first),
    },
  }));

describe('the policy engine with generated policies', () => {
  it('lets nothing through outside the interactive mode', () => {
    fc.assert(
      fc.property(
        policy,
        request,
        fc.constantFrom('unattended' as const, 'operator' as const),
        (generated, write, mode) => {
          expect(matchPolicy(generated, { ...write, mode }).kind).toBe('deny');
        },
      ),
    );
  });

  it('never lets an operation that always goes to the queue through', () => {
    fc.assert(
      fc.property(policy, request, (generated, write) => {
        expect(matchPolicy(generated, { ...write, alwaysQueue: true })).toEqual(
          { kind: 'queue', reason: 'queue_only' },
        );
      }),
    );
  });

  it('allows without a limit only when the interactive part has no entry', () => {
    fc.assert(
      fc.property(policy, request, (generated, write) => {
        const match = matchPolicy(generated, write);
        if (match.kind === 'allow') {
          expect(generated.interactive.targets).toEqual([]);
          expect(['group', 'service']).not.toContain(write.target.kind);
        }
      }),
    );
  });

  it('matches only an entry that names the tool, with its own counter and limit', () => {
    fc.assert(
      fc.property(policy, request, (generated, write) => {
        const match = matchPolicy(generated, write);
        if (match.kind === 'entry') {
          expect(match.entry.tools).toContain(write.tool);
          expect(match.counter).toBe(
            `write:${write.tool}:${targetKeyOf(match.entry.target)}`,
          );
          expect(match.maxPerDay).toBe(match.entry.maxPerDay);
        }
        const named = generated.interactive.targets.some((entry) =>
          entry.tools.includes(write.tool),
        );
        if (
          generated.interactive.targets.length > 0 &&
          !named &&
          !write.alwaysQueue
        ) {
          expect(match).toEqual({ kind: 'queue', reason: 'no_entry' });
        }
      }),
    );
  });

  it('never lets a write through with another name or at the limit', () => {
    fc.assert(
      fc.property(
        policy,
        request,
        fc.integer({ min: 0, max: 8 }),
        fc.boolean(),
        fc.boolean(),
        (generated, write, count, counted, rename) => {
          const match = matchPolicy(generated, write);
          if (match.kind !== 'entry') return;
          const names = match.names.map((expected, index) =>
            rename && index === 0 ? `${expected.name} ` : expected.name,
          );
          const verdict = judgeMatch(match, { names, count, counted });
          const over = counted
            ? count > match.maxPerDay
            : count >= match.maxPerDay;
          if (rename) {
            expect(verdict).toEqual({ kind: 'queue', reason: 'name_changed' });
          } else if (over) {
            expect(verdict).toEqual({ kind: 'queue', reason: 'limit_reached' });
          } else {
            expect(verdict).toEqual({ kind: 'allow' });
          }
        },
      ),
    );
  });
});
