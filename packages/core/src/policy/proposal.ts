/**
 * A proposal for the interactive part of the policy (ADR 0032), as
 * `ecclium policy init --interactive` writes it to stdout for the operator
 * to check: one entry per category of the wiki that a write tool reached,
 * with its name from ChurchTools, the tools seen on it and a daily limit
 * from what the audit shows.
 *
 * The text is YAML that the loader of the policy reads as it is, written
 * here without the library for YAML, which only the reader of the policy
 * imports. A name stands in double quotes, and every character outside
 * printable ASCII, the German umlauts and the quotes «» and ‹› is an
 * escape of YAML, so that the command line passes the text to a terminal
 * and the loader reads back the name as ChurchTools gave it. A name the
 * policy would refuse, and a category without a name, stand only as a
 * comment.
 *
 * @packageDocumentation
 */
import { toolNamePattern } from '../logger/index.js';
import { policyLimits } from './schema.js';

/** A category of the wiki that a write tool reached, as the audit shows. */
export interface ProposedCategory {
  /** The ID of the category. */
  readonly id: number;
  /**
   * Its name in ChurchTools, or undefined when the list of categories of
   * the account does not name it.
   */
  readonly name: string | undefined;
  /** The write tools seen on it. */
  readonly tools: readonly string[];
  /**
   * The most calls of one of these tools on it on one UTC day, counting
   * only calls that planned or sent a write; 0 when all were refused.
   */
  readonly highestPerDay: number;
}

/** What a proposal is made of. */
export interface ProposalInput {
  /** The categories, in any order. */
  readonly categories: readonly ProposedCategory[];
  /** The read budget of the policy in force, kept in the proposal. */
  readonly readBudgetPerDay: number;
  /** The first and the last UTC day of the audit read, if it had a line. */
  readonly days?: { readonly first: string; readonly last: string };
}

/** The lowest daily limit a proposal gives. */
export const minProposedPerDay = 5;

/**
 * The daily limit a proposal gives an entry: twice the highest day, at
 * least {@link minProposedPerDay} and at most the limit of the policy.
 *
 * @param highestPerDay - The most calls of one tool on one UTC day.
 * @returns The limit for `maxPerDay`.
 * @example
 * ```ts
 * proposedMaxPerDay(4); // 8
 * ```
 */
export function proposedMaxPerDay(highestPerDay: number): number {
  const twice = Number.isSafeInteger(highestPerDay) ? highestPerDay * 2 : 0;
  return Math.min(policyLimits.maxPerDay, Math.max(minProposedPerDay, twice));
}

// The characters beyond printable ASCII that the command line shows: the
// umlauts and the quotes «» and ‹›, as in its writers.
const shownLetters: readonly number[] = Object.freeze([
  0xab, 0xbb, 0xc4, 0xd6, 0xdc, 0xe4, 0xf6, 0xfc, 0x2039, 0x203a,
]);

const hex = (code: number, width: number): string =>
  code.toString(16).toUpperCase().padStart(width, '0');

/**
 * Writes a name as a double-quoted scalar of YAML that holds only
 * characters the command line shows.
 *
 * @param name - A name the policy accepts.
 * @returns The scalar, quotes included.
 */
const quoted = (name: string): string => {
  let text = '"';
  for (const character of name) {
    // A character of the iteration has a code point at 0.
    const code = Number(character.codePointAt(0));
    if (character === '"' || character === '\\') {
      text += `\\${character}`;
    } else if ((code >= 0x20 && code <= 0x7e) || shownLetters.includes(code)) {
      text += character;
    } else if (code <= 0xffff) {
      text += `\\u${hex(code, 4)}`;
    } else {
      text += `\\U${hex(code, 8)}`;
    }
  }
  return `${text}"`;
};

// A name the policy takes: 1 to 255 characters, no control character, and
// well formed, so that no half of a pair of surrogates reaches an escape.
const namePattern = /^\P{Cc}+$/u;
const nameFits = (name: string): boolean =>
  name.length >= 1 &&
  name.length <= policyLimits.name &&
  name.isWellFormed() &&
  namePattern.test(name);

const dayPattern = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Writes the proposal. The categories are sorted by ID, the tools of each
 * by name, each once; a tool whose name the policy would refuse is left
 * out. At most 200 entries, the most a part of the policy holds.
 *
 * @param input - The categories, the read budget and the days read.
 * @returns The text, lines ending in a line break.
 * @example
 * ```ts
 * renderPolicyProposal({
 *   categories: [{ id: 12, name: 'Berichte', tools: ['ct_wiki_page_create'], highestPerDay: 4 }],
 *   readBudgetPerDay: 200,
 * });
 * ```
 */
export function renderPolicyProposal(input: ProposalInput): string {
  const lines = [
    '# Vorschlag von «ecclium policy init --interactive» für den interaktiven Teil der Richtlinie.',
  ];
  const { days } = input;
  if (
    days !== undefined &&
    dayPattern.test(days.first) &&
    dayPattern.test(days.last)
  ) {
    lines.push(
      `# Grundlage: die Audit-Dateien vom ${days.first} bis ${days.last} (UTC).`,
    );
  } else {
    lines.push('# Grundlage: Das Audit enthält keine Zeile.');
  }
  lines.push(
    '# Ein Eintrag je Kategorie des Wikis, auf die ein Schreib-Tool zugegriffen hat, auch wenn es abgelehnt wurde.',
    `# maxPerDay ist das Doppelte des höchsten Tageswerts eines Tools, mindestens ${String(minProposedPerDay)}.`,
    '# Prüfen Sie jeden Eintrag, bevor Sie die Datei mit ECCLIUM_POLICY_FILE einsetzen.',
    'schema: policy.v1',
    'interactive:',
    `  readBudgetPerDay: ${String(input.readBudgetPerDay)}`,
  );
  const entries: string[] = [];
  const skipped: string[] = [];
  const sorted = [...input.categories].sort((a, b) => a.id - b.id);
  let more = 0;
  for (const category of sorted) {
    const id = String(category.id);
    const tools = [...new Set(category.tools)]
      .filter((tool) => tool.length <= 63 && toolNamePattern.test(tool))
      .sort()
      .slice(0, policyLimits.tools);
    const { name } = category;
    if (name === undefined || !nameFits(name)) {
      skipped.push(
        name === undefined
          ? `    # Kategorie ${id}: ChurchTools nennt dem Konto keinen Namen, darum kein Eintrag.`
          : `    # Kategorie ${id}: Ihr Name passt nicht in die Richtlinie, darum kein Eintrag.`,
      );
      continue;
    }
    if (tools.length === 0) continue;
    if (entries.length / 3 >= policyLimits.entries) {
      more += 1;
      continue;
    }
    entries.push(
      `    - target: { kind: wiki_category, id: ${id}, name: ${quoted(name)} }`,
      `      tools: [${tools.join(', ')}]`,
      `      maxPerDay: ${String(proposedMaxPerDay(category.highestPerDay))}`,
    );
  }
  if (entries.length === 0) {
    lines.push(
      '  # Keine Einträge: Erlaubt ist dann jeder bestätigte Schreibvorgang, den das Dienstkonto darf, ausser bei Gruppen und Diensten.',
      '  targets: []',
    );
  } else {
    lines.push('  targets:', ...entries);
  }
  lines.push(...skipped);
  if (more > 0) {
    lines.push(
      `    # Weitere ${String(more)} Kategorien passen nicht mehr in die ${String(policyLimits.entries)} Einträge eines Teils.`,
    );
  }
  return `${lines.join('\n')}\n`;
}
