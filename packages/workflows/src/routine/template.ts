/**
 * The template of a routine: read and checked against its blocks
 * (ADR 0033).
 *
 * Where it stands in a run: the loader reads the template with the
 * routine, long before a run, and keeps the parsed form. At the end of a
 * run, after the model or the checks filled the blocks and every text
 * passed the content policy, the core renders the blocks into it and the
 * whole text goes through the content policy once more.
 *
 * Why it knows so little: a template is written by the operator but
 * rendered with what a model wrote, and a model may follow an instruction
 * in the data it read. So a template has no conditions, no expressions
 * and no code, and the core puts the text of a field in as plain text.
 * It knows four tags, a small part of the syntax of Mustache:
 *
 * - `{{#block}}` … `{{/block}}` repeats its lines for each entry of the
 *   block, and `{{field}}` inside stands for a field of the entry.
 * - `{{^block}}` … `{{/block}}` shows its lines only when the block is
 *   empty, as the fixed text for an empty block.
 * - `{{period}}` stands for the period of the run, such as `2026-W46`,
 *   anywhere.
 *
 * A tag of a section stands alone on its line, and the line goes when the
 * core renders. Sections do not nest. Every other `{{` is refused, so a
 * partial, an unescaped field or a change of delimiters cannot slip in.
 * Every block appears in a repeating section, so that nothing a run fills
 * goes unseen.
 *
 * @packageDocumentation
 */
import type { RoutineBlock } from './schema.js';

/** Why a template is refused, frozen. */
export const templateCodes = Object.freeze([
  'template_characters',
  'template_tag',
  'template_section_line',
  'template_nesting',
  'template_block_unknown',
  'template_field_unknown',
  'template_block_unused',
] as const);

/** Why a template is refused. */
export type TemplateCode = (typeof templateCodes)[number];

/** A part of a template that renders the same for every entry or once. */
export type TemplateLeaf =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'period' }
  | { readonly kind: 'field'; readonly field: string };

/** A part of a template at its top level. */
export type TemplateNode =
  | TemplateLeaf
  | {
      /** `repeat` for each entry of the block, `empty` when it has none. */
      readonly kind: 'repeat' | 'empty';
      readonly block: string;
      readonly parts: readonly TemplateLeaf[];
    };

/** A checked template, deeply frozen. */
export interface Template {
  readonly parts: readonly TemplateNode[];
}

/** The parsed template, or why it is refused. */
export type TemplateResult =
  | { readonly ok: true; readonly template: Template }
  | {
      readonly ok: false;
      readonly code: TemplateCode;
      /** The line of the problem, from 1, when it lies in one. */
      readonly line?: number;
    };

/** The name of the tag that stands for the period of a run. */
export const periodTag = 'period';

// A tag of a section alone on its line, with spaces or tabs around it.
// The name is one of a block: one the routine chose, in lower case, or
// the name of a check of the core, such as `brokenLinks`.
const sectionLine = /^[ \t]*\{\{([#^/])([a-z][a-zA-Z0-9_]{0,31})\}\}[ \t]*$/;
// A tag inside a line: a field or the period, nothing else.
const inlineTag = /^\{\{([a-z][a-zA-Z0-9_]{0,31})\}\}/;
// A control character other than the tab. Lines are split at line feeds
// already, so a carriage return alone counts as well.
const control = /[^\P{Cc}\t]/u;

interface Open {
  readonly kind: 'repeat' | 'empty';
  readonly block: string;
  readonly parts: TemplateLeaf[];
}

const refuse = (code: TemplateCode, line?: number): TemplateResult =>
  Object.freeze({
    __proto__: null,
    ok: false,
    code,
    ...(line === undefined ? {} : { line }),
  });

// Adds text to the parts, joined with text right before it.
const addText = (parts: TemplateLeaf[], text: string): void => {
  if (text === '') return;
  const last = parts.at(-1);
  if (last?.kind === 'text') {
    parts[parts.length - 1] = { kind: 'text', text: last.text + text };
  } else {
    parts.push({ kind: 'text', text });
  }
};

// The parts of one line that holds no tag of a section, or the code of
// its problem. A field needs an open repeating section with that field.
const lineParts = (
  line: string,
  open: Open | undefined,
  blocks: Readonly<Record<string, RoutineBlock>>,
): TemplateLeaf[] | TemplateCode => {
  const parts: TemplateLeaf[] = [];
  let rest = line;
  for (;;) {
    const at = rest.indexOf('{{');
    if (at === -1) break;
    addText(parts, rest.slice(0, at));
    rest = rest.slice(at);
    const tag = inlineTag.exec(rest);
    if (tag === null) {
      return /^\{\{[#^/]/.test(rest) ? 'template_section_line' : 'template_tag';
    }
    const [whole, field = ''] = tag;
    if (field === periodTag) {
      parts.push({ kind: 'period' });
    } else if (
      open?.kind === 'repeat' &&
      Object.hasOwn(blocks[open.block]?.fields ?? {}, field)
    ) {
      parts.push({ kind: 'field', field });
    } else {
      return 'template_field_unknown';
    }
    rest = rest.slice(whole.length);
  }
  addText(parts, rest);
  return parts;
};

const freezeLeaves = (parts: readonly TemplateLeaf[]) =>
  Object.freeze(parts.map((part) => Object.freeze({ ...part })));

/**
 * Parses the template of a routine and checks it against the blocks the
 * routine fills.
 *
 * @param text - The text of the template, Markdown with the four tags.
 *   Lines may end with a line feed or a carriage return and a line feed;
 *   the parsed form has line feeds only.
 * @param blocks - The blocks of the routine by name, with their fields.
 * @returns The parsed template, deeply frozen, or the code of the first
 *   problem with its line. It never throws for a text.
 * @throws {TypeError} When the text is not a string.
 * @example
 * ```ts
 * const parsed = parseTemplate('{{#hinweise}}\n- {{text}}\n{{/hinweise}}\n', blocks);
 * if (!parsed.ok) report(parsed.code, parsed.line);
 * ```
 */
export function parseTemplate(
  text: string,
  blocks: Readonly<Record<string, RoutineBlock>>,
): TemplateResult {
  if (typeof text !== 'string') {
    throw new TypeError('The text of the template must be a string.');
  }
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  const nodes: TemplateNode[] = [];
  const top: TemplateLeaf[] = [];
  const repeated = new Set<string>();
  let open: Open | undefined;

  // Text at the top level goes into the list of nodes in order, joined
  // with text right before it, like the parts of a section.
  const flushTop = (): void => {
    for (const part of top) {
      const last = nodes.at(-1);
      if (part.kind === 'text' && last?.kind === 'text') {
        nodes[nodes.length - 1] = { kind: 'text', text: last.text + part.text };
      } else {
        nodes.push(part);
      }
    }
    top.length = 0;
  };

  for (const [index, line] of lines.entries()) {
    const number = index + 1;
    if (control.test(line)) return refuse('template_characters', number);
    // The last line has no line feed after it; every other one has.
    const end = index === lines.length - 1 ? '' : '\n';
    const section = sectionLine.exec(line);
    if (section !== null) {
      const [, sign, block = ''] = section;
      if (!Object.hasOwn(blocks, block)) {
        return refuse('template_block_unknown', number);
      }
      if (sign === '/') {
        if (open?.block !== block) return refuse('template_nesting', number);
        nodes.push(
          Object.freeze({
            kind: open.kind,
            block,
            parts: freezeLeaves(open.parts),
          }),
        );
        open = undefined;
      } else {
        if (open !== undefined) return refuse('template_nesting', number);
        flushTop();
        open = { kind: sign === '#' ? 'repeat' : 'empty', block, parts: [] };
        if (sign === '#') repeated.add(block);
      }
      continue;
    }
    const parts = lineParts(line, open, blocks);
    if (typeof parts === 'string') return refuse(parts, number);
    const target = open === undefined ? top : open.parts;
    for (const part of parts) {
      if (part.kind === 'text') addText(target, part.text);
      else target.push(part);
    }
    addText(target, end);
  }
  if (open !== undefined) return refuse('template_nesting', lines.length);
  flushTop();
  if (Object.keys(blocks).some((block) => !repeated.has(block))) {
    return refuse('template_block_unused');
  }
  return Object.freeze({
    __proto__: null,
    ok: true,
    template: Object.freeze({
      parts: Object.freeze(
        nodes.map((node) =>
          Object.isFrozen(node) ? node : Object.freeze(node),
        ),
      ),
    }),
  });
}
