/**
 * The hash of a plan (ADR 0029): SHA-256 over tenant, actor, tool, kind of
 * intent, target, base version and the hash of the new content.
 *
 * Where it stands in the way of a write: planning computes it when it
 * seals a plan, and committing computes it again from the state of the
 * target right before it writes. Only when both are equal does the core
 * write; a target that changed in between gives another hash and ends the
 * write in a conflict. A confirmation and an approval of the queue name
 * the hash, so they hold for exactly this plan.
 *
 * The encoding is fixed and leaves no room for two inputs to meet: the
 * first field is a tag of the version of the encoding, the others follow
 * in a fixed order, and each field, the tag included, is its length in
 * bytes as a decimal number, a colon and its bytes in UTF-8. No value can
 * end one field and start the next, whatever it holds.
 *
 * @packageDocumentation
 */
import { createHash } from 'node:crypto';

import type { ActorKind } from '@ecclium/mcp-churchtools-plugin-api';

import type { TargetKind } from './rules.js';

// The tags of the two encodings. A later change of either gets a new tag,
// so that no hash of one version equals one of another.
const planTag = 'ecclium.plan.v1';
const contentTag = 'ecclium.content.v1';

const encoder = new TextEncoder();

// The fields after the tag, each with its length in bytes before it.
const hashOf = (tag: string, fields: readonly string[]): string => {
  const hash = createHash('sha256');
  for (const field of [tag, ...fields]) {
    if (!field.isWellFormed()) {
      throw new TypeError('A field of a hash is well-formed text.');
    }
    const bytes = encoder.encode(field);
    hash.update(`${String(bytes.byteLength)}:`);
    hash.update(bytes);
  }
  return hash.digest('hex');
};

/**
 * Hashes the content a plan would write, in the order its kind gives, such
 * as title and text of a new page.
 *
 * @param parts - The parts of the content.
 * @returns SHA-256 in lowercase hex.
 * @throws {TypeError} For a part with a lone surrogate.
 * @example
 * ```ts
 * contentHashOf(['Plan', '# Plan']);
 * ```
 */
export function contentHashOf(parts: readonly string[]): string {
  return hashOf(contentTag, [String(parts.length), ...parts]);
}

/** What the hash of a plan covers. */
export interface PlanHashInput {
  /** The tenant. */
  readonly tenantId: string;
  /** The kind of the actor. */
  readonly actorKind: ActorKind;
  /** The ID of the actor. */
  readonly actorId: string;
  /** The tool that planned. */
  readonly tool: string;
  /** The kind of the intent. */
  readonly intentKind: string;
  /** The kind of the target. */
  readonly targetKind: TargetKind;
  /** The key of the target. */
  readonly targetKey: string;
  /** The version the write is based on, or null for one without. */
  readonly baseVersion: number | null;
  /** The hash of the new content, from {@link contentHashOf}. */
  readonly contentHash: string;
}

/**
 * Computes the hash of a plan.
 *
 * @param input - Tenant, actor, tool, intent, target, base version and
 *   hash of the content.
 * @returns SHA-256 in lowercase hex.
 * @throws {TypeError} For a base version that is no whole number from 0
 *   and for a field with a lone surrogate.
 * @example
 * ```ts
 * planHashOf({ tenantId: 'default', actorKind: 'service',
 *   actorId: 'stdio:local-stdio', tool: 'ct_wiki_page_update',
 *   intentKind: 'wikiPageUpdate', targetKind: 'wiki_page',
 *   targetKey: '12/<guid>', baseVersion: 3, contentHash });
 * ```
 */
export function planHashOf(input: PlanHashInput): string {
  const { baseVersion } = input;
  if (
    baseVersion !== null &&
    (!Number.isSafeInteger(baseVersion) || baseVersion < 0)
  ) {
    throw new TypeError('A base version is a whole number from 0.');
  }
  return hashOf(planTag, [
    input.tenantId,
    input.actorKind,
    input.actorId,
    input.tool,
    input.intentKind,
    input.targetKind,
    input.targetKey,
    // Empty for a write without a base version, which no number writes as.
    baseVersion === null ? '' : String(baseVersion),
    input.contentHash,
  ]);
}
