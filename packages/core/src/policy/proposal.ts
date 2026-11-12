/**
 * A proposal for the interactive part of the policy (ADR 0032), as
 * `ecclium policy init --interactive` writes it to stdout for the operator
 * to check: one entry per category of the wiki, calendar and resource
 * that a write tool reached, with its name from ChurchTools, the tools
 * seen on it and a daily limit from what the audit shows.
 *
 * The text is YAML that the loader of the policy reads as it is, written
 * here without the library for YAML, which only the reader of the policy
 * imports. A name stands in double quotes, and every character outside
 * printable ASCII, the German umlauts and the quotes «» and ‹› is an
 * escape of YAML, so that the command line passes the text to a terminal
 * and the loader reads back the name as ChurchTools gave it. A name the
 * policy would refuse, and a category without a name, stand only as a
 * comment. So does a calendar or a resource, which the proposal names
 * after the categories, each kind sorted by ID.
 *
 * @packageDocumentation
 */
import { toolNamePattern } from '../logger/index.js';
import { policyLimits } from './schema.js';

/**
 * A category of the wiki, a calendar or a resource that a write tool
 * reached, as the audit shows.
 */
export interface ProposedTarget {
  /** The ID of the category, calendar or resource. */
  readonly id: number;
  /**
   * Its name in ChurchTools, or undefined when the list of the account
   * does not name it.
   */
  readonly name: string | undefined;
  /**
   * Whether the redaction changed the name before the command line saw
   * it, by removing hidden characters or masking a part: then the name
   * above is not the one ChurchTools compares, and the target stands only
   * as a comment.
   */
  readonly nameChanged?: boolean;
  /** The write tools seen on it. */
  readonly tools: readonly string[];
  /**
   * The most calls of one of these tools on it on one UTC day, without
   * the refused and the skipped ones; 0 when the audit shows only those.
   */
  readonly highestPerDay: number;
}

/** A category of the wiki that a write tool reached, as the audit shows. */
export type ProposedCategory = ProposedTarget;

/** What a proposal is made of. */
export interface ProposalInput {
  /** The categories, in any order. */
  readonly categories: readonly ProposedTarget[];
  /** The calendars, in any order; none when left out. */
  readonly calendars?: readonly ProposedTarget[];
  /** The resources, in any order; none when left out. */
  readonly resources?: readonly ProposedTarget[];
  /** The read budget of the policy in force, kept in the proposal. */
  readonly readBudgetPerDay: number;
  /** The contact values of the policy in force, kept in the proposal. */
  readonly contacts?: readonly string[];
  /** Whom to ask, of the policy in force, kept in the proposal. */
  readonly inquiriesTo?: string;
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
 * characters the command line shows. For the proposals of this folder.
 *
 * @param name - A name the policy accepts.
 * @returns The scalar, quotes included.
 * @example
 * ```ts
 * yamlQuoted('Bericht «neu»'); // '"Bericht «neu»"'
 * ```
 */
export const yamlQuoted = (name: string): string => {
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

/**
 * Whether the policy takes a name as it is, for the proposals of this
 * folder.
 *
 * @param name - The name.
 * @returns Whether it has 1 to 255 characters, no control character and
 *   no half of a pair of surrogates.
 * @example
 * ```ts
 * policyNameFits('Berichte'); // true
 * ```
 */
export const policyNameFits = (name: string): boolean =>
  name.length >= 1 &&
  name.length <= policyLimits.name &&
  name.isWellFormed() &&
  namePattern.test(name);

const dayPattern = /^\d{4}-\d{2}-\d{2}$/;

/** How the proposal names the targets of one kind in its comments. */
interface KindWords {
  /** The kind as the policy writes it. */
  readonly kind: 'wiki_category' | 'calendar' | 'resource';
  /** The noun before the ID of a target. */
  readonly noun: string;
  /** The possessive of its name, after the gender of the noun. */
  readonly its: string;
}

const categoryWords: KindWords = {
  kind: 'wiki_category',
  noun: 'Kategorie',
  its: 'Ihr',
};
const calendarWords: KindWords = {
  kind: 'calendar',
  noun: 'Kalender',
  its: 'Sein',
};
const resourceWords: KindWords = {
  kind: 'resource',
  noun: 'Ressource',
  its: 'Ihr',
};

/**
 * Writes the proposal. The categories come first, then the calendars and
 * the resources, each kind sorted by ID, the tools of each by name, each
 * once; a tool whose name the policy would refuse is left out. At most 200
 * entries, the most a part of the policy holds. A proposal of categories
 * alone keeps the words of one about the wiki.
 *
 * @param input - The targets, the read budget and the days read.
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
  const calendars = input.calendars ?? [];
  const resources = input.resources ?? [];
  // Only the wiki: the words of a proposal before calendars and resources.
  const wikiOnly = calendars.length === 0 && resources.length === 0;
  lines.push(
    wikiOnly
      ? '# Ein Eintrag je Kategorie des Wikis, die das Audit in einer Zeile eines Schreib-Tools nennt, auch bei abgelehnten Versuchen.'
      : '# Ein Eintrag je Kategorie des Wikis, je Kalender und je Ressource, die das Audit in einer Zeile eines Schreib-Tools nennt, auch bei abgelehnten Versuchen.',
    `# maxPerDay ist das Doppelte des höchsten Tageswerts eines Tools, mindestens ${String(minProposedPerDay)}, ohne abgelehnte und übersprungene Aufrufe.`,
    '# Prüfen Sie jeden Eintrag, bevor Sie die Datei mit ECCLIUM_POLICY_FILE einsetzen.',
    'schema: policy.v1',
    'interactive:',
  );
  const entries: string[] = [];
  const skipped: string[] = [];
  const sorted = [
    ...[...input.categories]
      .sort((a, b) => a.id - b.id)
      .map((target) => ({ target, words: categoryWords })),
    ...[...calendars]
      .sort((a, b) => a.id - b.id)
      .map((target) => ({ target, words: calendarWords })),
    ...[...resources]
      .sort((a, b) => a.id - b.id)
      .map((target) => ({ target, words: resourceWords })),
  ];
  let count = 0;
  let more = 0;
  for (const { target, words } of sorted) {
    const id = String(target.id);
    const { noun, its } = words;
    const tools = [...new Set(target.tools)]
      .filter((tool) => tool.length <= 63 && toolNamePattern.test(tool))
      .sort()
      .slice(0, policyLimits.tools);
    const { name } = target;
    if (name === undefined) {
      skipped.push(
        `    # ${noun} ${id}: ChurchTools nennt dem Konto keinen Namen, darum kein Eintrag.`,
      );
      continue;
    }
    if (target.nameChanged === true) {
      skipped.push(
        `    # ${noun} ${id}: ${its} Name kam verändert an, ohne unsichtbare Zeichen oder mit einem maskierten Teil, darum kein Eintrag. Tragen Sie ihn von Hand ein.`,
      );
      continue;
    }
    if (!policyNameFits(name)) {
      skipped.push(
        `    # ${noun} ${id}: ${its} Name passt nicht in die Richtlinie, darum kein Eintrag.`,
      );
      continue;
    }
    if (tools.length === 0) continue;
    if (count >= policyLimits.entries) {
      more += 1;
      continue;
    }
    count += 1;
    // A target that the audit shows only refused came from a wish, maybe
    // of the model, not from a write; the operator decides on it.
    if (target.highestPerDay === 0) {
      entries.push(
        '    # Nur abgelehnte oder übersprungene Versuche im Audit: Prüfen Sie, ob Ecclium hier schreiben soll.',
      );
    }
    entries.push(
      `    - target: { kind: ${words.kind}, id: ${id}, name: ${yamlQuoted(name)} }`,
      `      tools: [${tools.join(', ')}]`,
      `      maxPerDay: ${String(proposedMaxPerDay(target.highestPerDay))}`,
    );
  }
  // The targets come before the read budget, so that a text cut off after
  // `targets:` is no file the loader takes. An empty list would allow every
  // confirmed write: it stands only when the audit names no target, and
  // when every target it names fell out, a placeholder keeps the file from
  // loading until the operator enters the targets.
  if (count > 0) {
    lines.push('  targets:', ...entries);
  } else if (sorted.length === 0) {
    lines.push(
      '  # Keine Einträge: Erlaubt ist dann jeder bestätigte Schreibvorgang, den das Dienstkonto darf, ausser bei Gruppen und Diensten.',
      '  targets: []',
    );
  } else {
    lines.push(
      `  # ${wikiOnly ? 'Keine Kategorie' : 'Kein Ziel'} liess sich vorschlagen, siehe die Kommentare unten. Eine leere Liste erlaubte jeden bestätigten Schreibvorgang, darum nimmt Ecclium diese Datei erst an, wenn Sie die Ziele von Hand eintragen.`,
      '  targets:',
      '    - ERSETZEN',
    );
  }
  lines.push(...skipped);
  if (more > 0) {
    lines.push(
      `    # Weitere ${String(more)} ${wikiOnly ? 'Kategorien' : 'Ziele'} passen nicht mehr in die ${String(policyLimits.entries)} Einträge eines Teils.`,
    );
  }
  lines.push(`  readBudgetPerDay: ${String(input.readBudgetPerDay)}`);
  // The contact values come from the checked policy in force, so the
  // loader takes them back as they are.
  if (input.contacts !== undefined && input.contacts.length > 0) {
    lines.push('  contacts:');
    for (const contact of input.contacts)
      lines.push(`    - ${yamlQuoted(contact)}`);
  }
  if (input.inquiriesTo !== undefined) {
    lines.push(`  inquiriesTo: ${yamlQuoted(input.inquiriesTo)}`);
  }
  return `${lines.join('\n')}\n`;
}
