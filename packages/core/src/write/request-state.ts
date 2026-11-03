/**
 * What the `requestState` of a question carries from the first round of a
 * write to the second (ADR 0029, ADR 0053).
 *
 * Where it stands in the way of a write: the first round plans, keeps the
 * sealed plan in the `PlanStore` and asks the person through the client.
 * The mount signs this state with the codec of the SDK and sends it with
 * the question; the client sends it back unchanged with the answer, and
 * the mount checks the signature before the second round starts. The
 * second round runs no tool: it compares the state with the call, uses up
 * its nonce, takes the plan from the store and commits it only with a yes.
 *
 * The client can read the state, so it holds no secret, no content and no
 * personal data: the version of its form, the tool, the hash of the plan,
 * a nonce and two hashes, one of tenant and actor and one of the input of
 * the call. The codec of the SDK binds the state to the method only, as it
 * sees nothing else over stdio; the hashes bind it to the principal and to
 * the input, and the key of the `PlanStore` binds the plan to the
 * principal a second time. This module knows nothing of the SDK, which
 * only the mount imports.
 *
 * @packageDocumentation
 */
import { createHash } from 'node:crypto';

import type { Actor } from '@ecclium/mcp-churchtools-plugin-api';
import { z } from 'zod';

/** The version of the form of the state. A new form gets a new number. */
export const confirmationStateVersion = 1;

/** The state of a question, as the mount signs it. */
export interface ConfirmationState {
  /** The version of the form, {@link confirmationStateVersion}. */
  readonly v: typeof confirmationStateVersion;
  /** The name of the tool that planned. */
  readonly tool: string;
  /** The hash of the sealed plan, 64 hex digits. */
  readonly planHash: string;
  /** A nonce of 32 hex digits, used up by the second round. */
  readonly nonce: string;
  /** The hash of tenant and actor of the call that planned. */
  readonly principal: string;
  /** The hash of the input of the call that planned. */
  readonly arguments: string;
}

const hex = (length: number): z.ZodString =>
  z.string().regex(new RegExp(`^[0-9a-f]{${String(length)}}$`));

// The names of tools have this form (ADR 0024); the state carries no
// longer name.
const stateSchema = z.strictObject({
  v: z.literal(confirmationStateVersion),
  tool: z.string().regex(/^ct_[a-z0-9_]{1,60}$/),
  planHash: hex(64),
  nonce: hex(32),
  principal: hex(64),
  arguments: hex(64),
});

/**
 * Reads a state that the codec of the mount verified. The signature proves
 * that this process made it; the form is checked all the same, so that a
 * state of another version of the form counts as none.
 *
 * @param value - The state as the mount hands it on.
 * @returns The state, frozen, or undefined for anything else.
 * @example
 * ```ts
 * readConfirmationState({ v: 1 }); // undefined
 * ```
 */
export function readConfirmationState(
  value: unknown,
): ConfirmationState | undefined {
  const parsed = stateSchema.safeParse(value);
  return parsed.success ? Object.freeze(parsed.data) : undefined;
}

const encoder = new TextEncoder();

// SHA-256 over a tag and fields, each field its length in bytes, a colon
// and its bytes in UTF-8, like the hash of a plan: no value can end one
// field and start the next.
const digestOf = (tag: string, fields: readonly string[]): string => {
  const hash = createHash('sha256');
  for (const field of [tag, ...fields]) {
    const bytes = encoder.encode(field);
    hash.update(`${String(bytes.byteLength)}:`);
    hash.update(bytes);
  }
  return hash.digest('hex');
};

/**
 * The hash of tenant and actor, so that a state made for one principal
 * counts for no other.
 *
 * @param tenantId - The tenant of the call.
 * @param actor - The actor of the call.
 * @returns SHA-256 in lowercase hex.
 * @example
 * ```ts
 * principalDigestOf('default', { kind: 'service', id: 'stdio:local-stdio' });
 * ```
 */
export function principalDigestOf(tenantId: string, actor: Actor): string {
  return digestOf('ecclium.principal.v1', [tenantId, actor.kind, actor.id]);
}

// JSON with the keys of every object sorted and without fields that hold
// undefined. A checked input holds only plain data.
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonical(item)).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Readonly<Record<string, unknown>>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`;
  }
  return value === undefined ? 'null' : JSON.stringify(value);
};

/**
 * The hash of the input of a call, as its schema parsed it, in a form that
 * does not depend on the order of keys. The second round of a question
 * must bring the input of the first.
 *
 * @param input - The input as the schema of the tool parsed it.
 * @returns SHA-256 in lowercase hex.
 * @example
 * ```ts
 * argumentsDigestOf({ b: 1, a: 2 }) === argumentsDigestOf({ a: 2, b: 1 }); // true
 * ```
 */
export function argumentsDigestOf(input: unknown): string {
  return digestOf('ecclium.arguments.v1', [canonical(input)]);
}
