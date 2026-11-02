/**
 * The texts of `ecclium policy init` (ADR 0032), for operators in German:
 * what happened, why, and what to do. No text repeats a value of the
 * configuration, a path or a name from ChurchTools.
 *
 * @packageDocumentation
 */
import type { ErrorCode } from '@ecclium/mcp-churchtools-plugin-api';

/** The problems of `ecclium policy init` that end it before a proposal. */
export type PolicyInitProblem =
  'interactive_missing' | 'state_dir_missing' | 'wiki_off' | 'folder_moved';

/** One text per problem. */
export const policyInitTexts: Readonly<Record<PolicyInitProblem, string>> =
  Object.freeze({
    interactive_missing:
      '‹ecclium policy init› braucht ‹--interactive›. Diese Version schlägt nur den interaktiven Teil der Richtlinie vor, den Teil für Routinen erst eine spätere mit dem Runner. Rufen Sie ‹ecclium policy init --interactive› auf.',
    state_dir_missing:
      'Ohne ‹ECCLIUM_STATE_DIR› gibt es keine Audit-Dateien, aus denen Ecclium einen Vorschlag machen könnte. Setzen Sie denselben Zustandsordner wie in der Konfiguration des KI-Assistenten.',
    wiki_off:
      'Für die Namen der Kategorien fragt Ecclium ChurchTools mit dem Tool ‹ct_wiki_categories_list›, und das gehört zum Toolset ‹wiki›, das die Konfiguration nicht einschaltet. Nehmen Sie ‹wiki› in ‹ECCLIUM_TOOLSETS› auf.',
    folder_moved:
      'Der Ordner ‹audit› hat sich beim Lesen geändert, darum schreibt Ecclium keinen Vorschlag. Versuchen Sie es erneut, wenn kein anderer Prozess den Zustandsordner umbaut.',
  });

/** The text when only some audit files could be read whole. */
export const partlyReadText =
  'Nicht alle Audit-Dateien liessen sich ganz lesen, der Vorschlag beruht nur auf den gelesenen. Prüfen Sie die Dateien mit ‹ecclium audit verify›.';

/** The text when the proposal did not reach stdout whole. */
export const outputCutText =
  'Der Vorschlag liess sich nicht ganz auf stdout schreiben. Leiten Sie die Ausgabe in eine Datei um und versuchen Sie es erneut.';

/**
 * The text when ChurchTools did not give the names of the categories.
 *
 * @param code - The stable code of the error, never its message.
 * @returns The text.
 * @example
 * ```ts
 * namesFailedText('network');
 * ```
 */
export function namesFailedText(code: ErrorCode): string {
  return `ChurchTools gab die Namen der Kategorien nicht heraus (Fehler ‹${code}›), darum schreibt Ecclium keinen Vorschlag. Prüfen Sie die Konfiguration mit ‹ecclium config check› und ob das Dienstkonto die Kategorien sehen darf, und versuchen Sie es erneut.`;
}
