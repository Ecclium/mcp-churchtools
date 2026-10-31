/**
 * The stage `serialize` of the pipeline, the only one that knows the types
 * of MCP (ADR 0024). The pipeline ends with an outcome of plain values; the
 * mount turns it into the result of `tools/call` here.
 *
 * @packageDocumentation
 */
import type { CallToolResult, TextContent } from '@modelcontextprotocol/server';

import type { ToolOutcome } from '../pipeline/index.js';
import { isRedacted } from '../redaction/redacted.js';

// A frozen block of text. The type of MCP has mutable fields, so the block
// and its list are frozen in place and keep that type.
const textBlock = (text: string): TextContent[] => {
  const block: TextContent = { type: 'text', text };
  Object.freeze(block);
  const content = [block];
  Object.freeze(content);
  return content;
};

// One right per line, as module and name, such as `churchdb: view
// alldata`. A name is one line of printable ASCII (ADR 0054), so the
// lines cannot run into each other, while a comma or a semicolon could
// stand in a name.
const failureText = (outcome: Extract<ToolOutcome, { ok: false }>): string => {
  const rights = outcome.error.missingRights ?? [];
  if (rights.length === 0) return outcome.error.message;
  return [
    outcome.error.message,
    'Missing rights:',
    ...rights.map(({ module, right }) => `- ${module}: ${right}`),
  ].join('\n');
};

/**
 * Turns the outcome of a call into the result of `tools/call`.
 *
 * A success becomes one text block whose text is exactly
 * `JSON.stringify(data)`, without indentation, and `structuredContent`
 * that is the same redacted value. The pipeline measures exactly these two
 * copies against the limit of 64 KiB (ADR 0024), so the text must not
 * change form. Clients that read only text see the same data as those that
 * read the structured result, envelope and masks included.
 *
 * A failure becomes one text block with `isError: true` and no
 * `structuredContent`: the English sentence of the error, which the
 * pipeline has masked, and for missing rights a line `Missing rights:`
 * with one line `- module: right` each. The code of the error stays in log
 * and audit.
 *
 * A success whose data lack the mark of a redacted result, which only the
 * pipeline gives, throws, so that no result goes out past the pipeline,
 * also not one that a cast made into a redacted result (ADR 0026). The
 * mount then answers with the fixed sentence of `internal` and writes its
 * fixed event, the trace an operator finds.
 *
 * It never throws for an outcome of the pipeline, whose data are a frozen
 * tree of plain values of JSON.
 *
 * @param outcome - The outcome of `ToolPipeline.call`.
 * @returns The result for the client, frozen, with the data shared, not
 *   copied.
 * @throws {TypeError} For the data of a success without the mark of a
 *   redacted result.
 * @example
 * ```ts
 * serializeOutcome({ ok: true, data: sealRedacted({ id: 1 }) });
 * // { content: [{ type: 'text', text: '{"id":1}' }],
 * //   structuredContent: { id: 1 } }
 * serializeOutcome({ ok: false, error: { code: 'validation',
 *   message: 'The input is not valid.' } });
 * // { content: [{ type: 'text', text: 'The input is not valid.' }],
 * //   isError: true }
 * ```
 */
export function serializeOutcome(outcome: ToolOutcome): CallToolResult {
  if (outcome.ok) {
    if (!isRedacted(outcome.data)) {
      throw new TypeError('A result without the mark of the pipeline.');
    }
    return Object.freeze({
      content: textBlock(JSON.stringify(outcome.data)),
      structuredContent: outcome.data,
    });
  }
  return Object.freeze({
    content: textBlock(failureText(outcome)),
    isError: true,
  });
}
