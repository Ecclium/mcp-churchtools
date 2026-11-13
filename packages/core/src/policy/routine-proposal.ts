/**
 * A proposal for the entry of a routine in the unattended part of the
 * policy (ADR 0032), as `ecclium policy init --routine` writes it to
 * stdout for the operator to check: the page of the output of the routine
 * as a target `wiki_page` with its category, its GUID and its name, the
 * alias of the account, the tool of the output and the limits of a run and
 * a day.
 *
 * Why only the entry: the text is one item of the list `unattended`,
 * which the operator adds to the file of the policy. On its own it is no
 * policy the loader takes, so it never takes the place of the file in
 * force unnoticed. That would drop the part `interactive`, and without
 * its targets the server would allow every confirmed write its account
 * may.
 *
 * The limits are as narrow as the routine allows: a run writes once, so
 * `maxPerRun` is 1, and `maxPerDay` is the most triggers of the schedule
 * on one UTC day, the day the counters of the policy count by, and one
 * more for a run by hand. The proposal never lowers the level of the call
 * of the model and never holds an exception for the rights of the
 * account; what the operator decides stands as a comment. So does every
 * reason why there is no entry, such as a page that is missing.
 *
 * @packageDocumentation
 */
import { wikiPageGuidPattern } from '@ecclium/mcp-churchtools-plugin-api';

import { tenantIdPattern, toolNamePattern } from '../logger/index.js';
import { policyNameFits, yamlQuoted } from './proposal.js';
import { policyLimits } from './schema.js';

/**
 * What the operator should know about the proposal for a routine, each as
 * a comment: why there is no entry, or what is theirs to decide.
 */
export type RoutineProposalNote =
  /** No category with the name of the routine reached the account. */
  | { readonly kind: 'category_missing' }
  /** The category has no page with the name of the routine. */
  | { readonly kind: 'page_missing' }
  /** More than one page carries the name of the routine. */
  | { readonly kind: 'page_ambiguous' }
  /**
   * A list was longer than the command reads, so the page may be in the
   * rest or have a twin there.
   */
  | { readonly kind: 'list_too_long'; readonly entries: number }
  /**
   * A name arrived changed by the redaction and counted as no match;
   * with a missing category or page only.
   */
  | { readonly kind: 'names_changed' }
  /** The routine wishes the level standard for its call of the model. */
  | { readonly kind: 'redaction_standard' }
  /** The routine chooses checks of the core instead of a model. */
  | { readonly kind: 'checks' }
  /** The policy in force has entries of the routine already. */
  | {
      readonly kind: 'existing';
      readonly count: number;
      /** Whether one of them names another alias than the proposal. */
      readonly otherCredential: boolean;
    };

/** The page of the output of a routine, as ChurchTools named it. */
export interface RoutineProposalPage {
  readonly categoryId: number;
  readonly guid: string;
  /** The name the entry expects, as the routine names the page. */
  readonly name: string;
}

/** What a proposal for a routine is made of. */
export interface RoutineProposalInput {
  /** The ID of the routine. */
  readonly routine: string;
  /** The alias of the account the routine reads and writes with. */
  readonly credential: string;
  /** The write tool of the output of the routine. */
  readonly tool: string;
  /** The page, or undefined when the notes say why there is none. */
  readonly page?: RoutineProposalPage;
  /** The most triggers of the schedule on one UTC day. */
  readonly triggersPerDay: number;
  /** The notes, in any order; each kind stands once, in a fixed order. */
  readonly notes: readonly RoutineProposalNote[];
}

/**
 * The daily limit a proposal for a routine gives: one more than the most
 * triggers on one UTC day, for a run by hand, and at most the limit of the
 * policy.
 *
 * @param triggersPerDay - The most triggers of the schedule on one UTC
 *   day; anything but a whole number from 1 counts as none.
 * @returns The limit for `maxPerDay`.
 * @example
 * ```ts
 * routineMaxPerDay(1); // 2
 * ```
 */
export function routineMaxPerDay(triggersPerDay: number): number {
  const triggers =
    Number.isSafeInteger(triggersPerDay) && triggersPerDay > 0
      ? triggersPerDay
      : 0;
  return Math.min(policyLimits.maxPerDay, triggers + 1);
}

// The kinds of the notes in the order of the comments: first why there is
// no entry, then what the operator decides.
const noteOrder: readonly RoutineProposalNote['kind'][] = Object.freeze([
  'category_missing',
  'page_missing',
  'page_ambiguous',
  'list_too_long',
  'names_changed',
  'existing',
  'redaction_standard',
  'checks',
]);

// A whole number with an apostrophe between groups of three digits, as
// the texts of Ecclium write numbers, such as 1'000.
const grouped = (value: number): string =>
  String(value).replaceAll(/\B(?=(?:\d{3})+$)/gu, "'");

// One note as a comment, in the words of the operator; what it says about
// entries of the policy in force depends on whether the proposal has one.
const noteText = (note: RoutineProposalNote, withEntry: boolean): string => {
  switch (note.kind) {
    case 'category_missing':
      return '# Eine Kategorie mit dem Namen aus output.scope.category nennt ChurchTools dem Konto nicht: Es gibt sie nicht, oder das Konto darf sie nicht sehen. Darum kein Eintrag. Prüfen Sie den Namen in der Routine und die Rechte des Kontos in ChurchTools und rufen Sie den Befehl erneut auf.';
    case 'page_missing':
      return '# In der Kategorie steht keine Seite mit dem Namen aus output.scope.page, oder das Konto darf die Seiten der Kategorie nicht sehen. Ein Lauf legt keine Seite an: Legen Sie die Seite von Hand an und rufen Sie den Befehl erneut auf. Darum kein Eintrag.';
    case 'page_ambiguous':
      return '# Mehr als eine Seite trägt den Namen aus output.scope.page. Darum kein Eintrag. Tragen Sie die richtige Seite mit ihrer GUID von Hand ein, ct_wiki_pages_list zeigt sie.';
    case 'list_too_long':
      return `# Die Liste der Seiten der Kategorie ist länger als die ${grouped(note.entries)} Einträge, die Ecclium liest. Darum kein Eintrag. Tragen Sie die Seite von Hand ein.`;
    case 'names_changed':
      return '# Mindestens ein Name kam verändert an, weil Ecclium unsichtbare Zeichen entfernt oder einen Teil maskiert hat, und zählt darum nicht als Treffer. Ist das Ziel darunter, tragen Sie es von Hand ein.';
    case 'existing': {
      const which =
        note.count === 1 ? 'einen Eintrag' : `${String(note.count)} Einträge`;
      const them = note.count === 1 ? 'ihn' : 'sie';
      const has = `# Die geltende Richtlinie hat schon ${which} für diese Routine${note.otherCredential ? ', mit einem anderen Konto' : ''}.`;
      return withEntry
        ? `${has} Ersetzen Sie ${them} durch diesen Vorschlag, statt den Vorschlag dazuzufügen: Alle Einträge einer Routine nennen dasselbe Konto und dieselbe Stufe für das Modell. Mit zwei Stufen nimmt Ecclium die Richtlinie nicht an, mit zwei Konten startet der Runner nicht.`
        : `${has} Dieser Vorschlag enthält keinen Eintrag: Lassen Sie ${them} stehen, bis ein Vorschlag mit Eintrag ${them} ersetzt.`;
    }
    case 'redaction_standard':
      return '# Die Routine wünscht für das Modell die Stufe standard. Ecclium schlägt sie nie vor, ohne modelRedaction gilt strict. Ob die Richtlinie standard erlaubt, entscheiden Sie: Setzen Sie dann modelRedaction: standard in jeden Eintrag der Routine.';
    case 'checks':
      return '# Die Routine wählt feste Prüfungen des Kerns statt eines Modells. Sie braucht kein modelRedaction, weil ihre Prüfungen in der Stufe standard lesen, und ihre Lese-Tools gehören nicht in tools: Der Eintrag erlaubt nur das Schreiben.';
  }
};

// Whether the page fits a target of the policy as it is.
const pageFits = (page: RoutineProposalPage): boolean =>
  Number.isSafeInteger(page.categoryId) &&
  page.categoryId >= 1 &&
  page.categoryId <= policyLimits.id &&
  wikiPageGuidPattern.test(page.guid) &&
  policyNameFits(page.name);

/**
 * Writes the proposal for a routine: a header, the notes as comments and,
 * with a page that fits, the one entry. Lines end in a line break.
 *
 * @param input - The routine, the alias, the tool, the page, the most
 *   triggers on one UTC day and the notes.
 * @returns The text.
 * @throws {TypeError} When the routine, the alias or the tool has another
 *   form than the policy takes, so that no value can break the YAML.
 * @example
 * ```ts
 * renderRoutineProposal({
 *   routine: 'dienstplan-report',
 *   credential: 'berichte',
 *   tool: 'ct_wiki_page_append_section',
 *   page: { categoryId: 7, guid: '00000000-0000-4000-8000-000000000001', name: 'Dienstplan' },
 *   triggersPerDay: 1,
 *   notes: [],
 * });
 * ```
 */
export function renderRoutineProposal(input: RoutineProposalInput): string {
  const { routine, credential, tool } = input;
  if (
    !tenantIdPattern.test(routine) ||
    !tenantIdPattern.test(credential) ||
    !toolNamePattern.test(tool)
  ) {
    throw new TypeError('The routine, the alias or the tool has another form.');
  }
  const { page } = input;
  const fits = page !== undefined && pageFits(page);
  const lines = [
    '# Vorschlag von «ecclium policy init --routine» für einen Eintrag im Teil unattended der Richtlinie.',
    '# Grundlage: die Routine aus ECCLIUM_ROUTINES_DIR und die Namen, die ChurchTools dem Konto aus --credential nennt.',
  ];
  if (fits) {
    lines.push(
      '# Fügen Sie den Eintrag in die Liste unattended der Datei aus ECCLIUM_POLICY_FILE ein, statt die Datei zu ersetzen, und rücken Sie ihn so weit ein wie die anderen Punkte der Liste. Fehlt die Liste, beginnen Sie sie mit der Zeile unattended:. Allein ist der Eintrag keine Richtlinie: Ohne den Teil interactive erlaubte der Server jeden bestätigten Schreibvorgang, den sein Konto darf, und ohne interactive.inquiriesTo hängt ein Lauf keinen Abschnitt an.',
      '# maxPerRun ist 1, weil ein Lauf höchstens einmal schreibt. maxPerDay ist die höchste Zahl der Auslösungen des Zeitplans an einem UTC-Tag, gerechnet in der Zone aus ECCLIUM_TIME_ZONE, und eins mehr für einen Lauf von Hand.',
    );
  } else {
    lines.push(
      '# Dieser Vorschlag enthält keinen Eintrag. Die Kommentare darunter sagen, warum.',
    );
  }
  for (const kind of noteOrder) {
    const note = input.notes.find((candidate) => candidate.kind === kind);
    if (note !== undefined) lines.push(noteText(note, fits));
  }
  if (page !== undefined && !fits) {
    lines.push(
      '# Die Kennung der Kategorie, die GUID oder der Name der Seite hat eine Form, die die Richtlinie nicht annimmt. Darum kein Eintrag. Prüfen Sie die Seite mit ct_wiki_pages_list und den Namen aus output.scope.page.',
    );
  }
  if (fits) {
    lines.push(
      // Quoted as well: an ID such as 2026 or true would read as a number
      // or a switch, and the policy takes only a text.
      `- routine: ${yamlQuoted(routine)}`,
      `  credential: ${yamlQuoted(credential)}`,
      `  target: { kind: wiki_page, categoryId: ${String(page.categoryId)}, guid: ${yamlQuoted(page.guid.toLowerCase())}, name: ${yamlQuoted(page.name)} }`,
      `  tools: [${tool}]`,
      '  maxPerRun: 1',
      `  maxPerDay: ${String(routineMaxPerDay(input.triggersPerDay))}`,
    );
  }
  return `${lines.join('\n')}\n`;
}
