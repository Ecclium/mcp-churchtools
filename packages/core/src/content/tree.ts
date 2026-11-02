/**
 * The part of Markdown the content policy writes, as a tree of its own
 * (ADR 0030): headings, paragraphs, lists, tables, bold and italic, and
 * text. Nothing else has a place in it.
 *
 * Where it stands in the way of a write: the lexer turns a text into this
 * tree or refuses it, the checks read the text of the tree as a reader
 * sees it, and the serializer writes the tree as the text that goes to
 * ChurchTools. Because the serializer only knows this tree, nothing the
 * lexer left out can reach the output, and no raw text of a token does.
 *
 * @packageDocumentation
 */

/** A run of text, bold or italic, inside a heading, paragraph or cell. */
export type Inline =
  | { readonly kind: 'text'; readonly text: string }
  | {
      readonly kind: 'strong' | 'emphasis';
      readonly children: readonly Inline[];
    };

/** A heading of level 1 to 6. */
export interface Heading {
  readonly kind: 'heading';
  readonly level: 1 | 2 | 3 | 4 | 5 | 6;
  readonly children: readonly Inline[];
}

/** A paragraph. Its text may hold line breaks, which a reader sees as spaces. */
export interface Paragraph {
  readonly kind: 'paragraph';
  readonly children: readonly Inline[];
}

/** One item of a list: paragraphs and lists inside it. */
export type ListItem = readonly (Paragraph | List)[];

/** A list, numbered from `start` or with bullets, tight or with blank lines. */
export interface List {
  readonly kind: 'list';
  readonly ordered: boolean;
  /** The number of the first item; 1 for a list with bullets. */
  readonly start: number;
  /** Whether blank lines stand between the items. */
  readonly loose: boolean;
  readonly items: readonly ListItem[];
}

/** How the text of a column stands. */
export type Alignment = 'left' | 'center' | 'right' | null;

/** The content of one cell of a table. */
export type Cell = readonly Inline[];

/** A table with a header row and any number of rows of the same width. */
export interface Table {
  readonly kind: 'table';
  readonly align: readonly Alignment[];
  readonly header: readonly Cell[];
  readonly rows: readonly (readonly Cell[])[];
}

/** One block of a text. */
export type Block = Heading | Paragraph | List | Table;

/** The most levels of lists inside each other. */
export const maxListDepth = 5;

/** The most levels of bold and italic inside each other. */
export const maxInlineDepth = 10;
