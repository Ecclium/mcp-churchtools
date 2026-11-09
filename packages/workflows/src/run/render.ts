/**
 * Rendering the blocks of a run into the template of its routine (ADR
 * 0033).
 *
 * Where it stands in a run: after the answer passed its checks, before
 * the whole section goes through the content policy once more. The
 * template is text of the operator, checked by the loader; every value is
 * text of the model or of ChurchTools, so the core sets each as plain
 * text, with every sign of punctuation escaped, and nothing a model wrote
 * can mark up, start a list or end a cell. A repeating section is written
 * once per entry of its block, a section for an empty block only when the
 * block has none, and `{{period}}` is the period of the run.
 *
 * The line of the marking with its check code is not added here: the
 * write guard adds it when it writes, because only it holds the key of
 * the check codes (ADR 0032).
 *
 * @packageDocumentation
 */
import { escapeRunText } from '@ecclium/mcp-churchtools-core';

import type { Template, TemplateLeaf } from '../routine/template.js';
import type { FilledBlocks } from './answer.js';

// One part of a line, for an entry of a block or none.
const leafText = (
  leaf: TemplateLeaf,
  period: string,
  entry: Readonly<Record<string, string>> | undefined,
): string => {
  switch (leaf.kind) {
    case 'text':
      return leaf.text;
    case 'period':
      return escapeRunText(period);
    case 'field':
      // The loader allows a field only inside a repeating section of its
      // block, so an entry with it is there.
      return escapeRunText(entry?.[leaf.field] ?? '');
  }
};

/**
 * Renders the filled blocks into a template.
 *
 * @param template - The template the loader parsed and checked.
 * @param blocks - The values of each block as plain text.
 * @param period - The period of the run, such as `2026-W46`.
 * @returns The section in Markdown, before the content policy.
 * @example
 * ```ts
 * renderSection(loaded.template, checked.blocks, '2026-W46');
 * ```
 */
export function renderSection(
  template: Template,
  blocks: FilledBlocks,
  period: string,
): string {
  let text = '';
  for (const node of template.parts) {
    switch (node.kind) {
      case 'repeat':
        for (const entry of blocks[node.block] ?? []) {
          for (const leaf of node.parts) text += leafText(leaf, period, entry);
        }
        break;
      case 'empty':
        if ((blocks[node.block] ?? []).length === 0) {
          for (const leaf of node.parts) {
            text += leafText(leaf, period, undefined);
          }
        }
        break;
      default:
        text += leafText(node, period, undefined);
    }
  }
  return text;
}
