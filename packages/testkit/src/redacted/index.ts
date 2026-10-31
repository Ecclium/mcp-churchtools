/**
 * Outcomes of a stand-in for the pipeline, for tests of a server that
 * check what the mount sends and not what the pipeline does. The mount
 * sends only data that carry the mark of a redacted result (ADR 0026), so
 * a stand-in marks its data through the subpath ./redaction/testing of
 * core, which only this folder imports. Only tests import testkit.
 *
 * @packageDocumentation
 */
import type { ToolOutcome } from '@ecclium/mcp-churchtools-core';
import { sealRedacted } from '@ecclium/mcp-churchtools-core/redaction/testing';

/**
 * The outcome of a successful call with the given data, marked as the
 * pipeline marks a redacted result.
 *
 * @param data - The data, as a redacted result holds them.
 * @returns The frozen outcome.
 * @example
 * ```ts
 * const pipeline: ToolPipeline = {
 *   call: () => Promise.resolve(redactedOutcome({ email: 'm***@example.org' })),
 * };
 * ```
 */
export function redactedOutcome(
  data: Readonly<Record<string, unknown>>,
): ToolOutcome {
  return Object.freeze({ ok: true, data: sealRedacted(data) });
}
