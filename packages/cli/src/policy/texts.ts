/**
 * The texts of `ecclium policy init` (ADR 0032), for operators in German:
 * what happened, why, and what to do. No text repeats a value of the
 * configuration, a path or a name from ChurchTools.
 *
 * @packageDocumentation
 */
import type { ErrorCode } from '@ecclium/mcp-churchtools-plugin-api';
import type { RoutineLoadProblem } from '@ecclium/mcp-churchtools-workflows';

import type { AccountPipelineCode } from '../compose/run-pipeline.js';
import { runAccountCauses } from '../queue/texts.js';
import type { PolicyInitCallProblem } from './call.js';

/** One text per wrong form of a call, before any file is read. */
export const policyInitCallTexts: Readonly<
  Record<PolicyInitCallProblem, string>
> = Object.freeze({
  mode_missing:
    '‹ecclium policy init› braucht ‹--interactive› für den interaktiven Teil der Richtlinie oder ‹--routine <Routine> --credential <Alias>› für den Eintrag einer Routine. Rufen Sie den Befehl in einer der beiden Formen auf.',
  mode_both:
    '‹ecclium policy init› schlägt in einem Aufruf entweder den interaktiven Teil der Richtlinie vor oder den Eintrag einer Routine, nicht beides. Rufen Sie den Befehl je einmal mit ‹--interactive› und mit ‹--routine› auf.',
  credential_missing:
    '‹--routine› braucht ‹--credential <Alias>›, das Konto, mit dem die Routine später schreibt. Mit ihm liest Ecclium die Namen, so dass ein fehlendes Leserecht jetzt auffällt und nicht erst beim ersten Lauf. Nennen Sie den Alias mit ‹--credential›.',
  credential_interactive:
    '‹--credential› gehört zu ‹--routine›: Den interaktiven Teil schlägt Ecclium mit dem Token des Servers vor. Lassen Sie ‹--credential› weg oder schlagen Sie mit ‹--routine› den Eintrag einer Routine vor.',
  routine_invalid:
    'Die Kennung aus ‹--routine› ist keine Kennung einer Routine: Kleinbuchstaben, Ziffern und Bindestriche, höchstens 63 Zeichen, am Anfang ein Buchstabe oder eine Ziffer. Ecclium nennt sie nicht noch einmal.',
  credential_invalid:
    'Der Alias aus ‹--credential› hat nicht die Form eines Alias der Richtlinie: Kleinbuchstaben, Ziffern und Bindestriche, höchstens 63 Zeichen, am Anfang ein Buchstabe oder eine Ziffer. Ecclium nennt ihn nicht noch einmal.',
});

/** The problems of `ecclium policy init` that end it before a proposal. */
export type PolicyInitProblem =
  'state_dir_missing' | 'wiki_off' | 'calendars_off' | 'folder_moved';

/** One text per problem. */
export const policyInitTexts: Readonly<Record<PolicyInitProblem, string>> =
  Object.freeze({
    state_dir_missing:
      'Ohne ‹ECCLIUM_STATE_DIR› gibt es keine Audit-Dateien, aus denen Ecclium einen Vorschlag machen könnte. Setzen Sie denselben Zustandsordner wie in der Konfiguration des KI-Assistenten.',
    wiki_off:
      'Für die Namen der Kategorien fragt Ecclium ChurchTools mit dem Tool ‹ct_wiki_categories_list›, und das gehört zum Toolset ‹wiki›, das die Konfiguration nicht einschaltet. Nehmen Sie ‹wiki› in ‹ECCLIUM_TOOLSETS› auf.',
    calendars_off:
      'Für die Namen der Kalender und Ressourcen fragt Ecclium ChurchTools mit den Tools ‹ct_calendars_list› und ‹ct_resources_list›, und die gehören zum Toolset ‹calendars›, das die Konfiguration nicht einschaltet. Nehmen Sie ‹calendars› in ‹ECCLIUM_TOOLSETS› auf.',
    folder_moved:
      'Der Ordner ‹audit› hat sich beim Lesen geändert, darum schreibt Ecclium keinen Vorschlag. Versuchen Sie es erneut, wenn kein anderer Prozess den Zustandsordner umbaut.',
  });

/** The text when only some audit files could be read whole. */
export const partlyReadText =
  'Nicht alle Audit-Dateien liessen sich ganz lesen, der Vorschlag beruht nur auf den gelesenen. Prüfen Sie die Dateien mit ‹ecclium audit verify›.';

/** The text when the proposal did not reach stdout whole. */
export const outputCutText =
  'Der Vorschlag liess sich nicht ganz auf stdout schreiben. Leiten Sie die Ausgabe in eine Datei um und versuchen Sie es erneut.';

/** The kinds of targets whose names the command asks ChurchTools for. */
export type NamedKind = 'categories' | 'calendars' | 'resources';

// The kinds in German, as the texts name them, with the pages of a
// category, which the entry of a routine reads.
const kindNames: Readonly<Record<NamedKind | 'pages', string>> = Object.freeze({
  categories: 'Kategorien',
  calendars: 'Kalender',
  resources: 'Ressourcen',
  pages: 'Seiten der Kategorie',
});

/**
 * The text when ChurchTools did not give the names of a kind of targets.
 *
 * @param code - The stable code of the error, never its message.
 * @param kind - The kind whose names were asked for, or the pages of a
 *   category.
 * @returns The text.
 * @example
 * ```ts
 * namesFailedText('network', 'calendars');
 * ```
 */
export function namesFailedText(
  code: ErrorCode,
  kind: NamedKind | 'pages',
): string {
  const what = kindNames[kind];
  return `ChurchTools gab die Namen der ${what} nicht heraus (Fehler ‹${code}›), darum schreibt Ecclium keinen Vorschlag. Prüfen Sie die Konfiguration mit ‹ecclium config check› und ob das Dienstkonto die ${what} sehen darf, und versuchen Sie es erneut.`;
}

/** The problems of `ecclium policy init --routine` before a proposal. */
export type RoutineProposalProblem =
  | 'routines_dir_unset'
  | 'routine_unknown'
  | 'time_zone_missing'
  | 'state_dir_missing';

/** One text per problem of the entry of a routine. */
export const routineProposalTexts: Readonly<
  Record<RoutineProposalProblem, string>
> = Object.freeze({
  routines_dir_unset:
    'Ohne ‹ECCLIUM_ROUTINES_DIR› findet Ecclium die Routine nicht. Setzen Sie die Variable auf den Ordner der Routinen, wie für den Runner.',
  routine_unknown:
    'Eine Routine mit dieser Kennung gibt es im Ordner aus ‹ECCLIUM_ROUTINES_DIR› nicht. Ecclium nennt die Kennung nicht noch einmal. Prüfen Sie die Schreibweise: Die Kennung ist der Name der Datei ohne ‹.yaml›.',
  time_zone_missing:
    'Für ‹maxPerDay› zählt Ecclium die Auslösungen des Zeitplans in der Zone, in der auch der Runner sie rechnet, und ‹ECCLIUM_TIME_ZONE› ist nicht gesetzt. Setzen Sie dieselbe Zone wie für den Runner.',
  state_dir_missing:
    'Jede Lesung des Befehls steht im Audit, und ohne ‹ECCLIUM_STATE_DIR› gibt es keine Audit-Datei. Setzen Sie denselben Zustandsordner wie in der Konfiguration des KI-Assistenten.',
});

/**
 * The line on stdout for a routine whose output is a draft, which needs no
 * entry: a comment, so that it changes nothing where it is pasted.
 */
export const draftNeedsNoEntryText =
  '# Die Routine schreibt einen Entwurf als Datei und nichts in ChurchTools. Sie braucht keinen Eintrag in der Richtlinie, darum schlägt Ecclium keinen vor.';

/**
 * Why the routines cannot be loaded: the code of the loader, the routine,
 * the field and the line where there are any, never a path or a value.
 *
 * @param problem - The first problem of the loader.
 * @returns One text.
 * @example
 * ```ts
 * routinesLoadText({ code: 'routine_yaml_syntax', routine: 'dienstplan-report', line: 4 });
 * ```
 */
export function routinesLoadText(problem: RoutineLoadProblem): string {
  const where = [
    problem.routine === undefined ? '' : ` in der Routine ‹${problem.routine}›`,
    problem.field === undefined ? '' : `, Feld ‹${problem.field}›`,
    problem.line === undefined ? '' : `, Zeile ${String(problem.line)}`,
  ].join('');
  return `Die Routinen im Ordner aus ‹ECCLIUM_ROUTINES_DIR› lassen sich nicht laden, Code ‹${problem.code}›${where}. Darum schlägt Ecclium keinen Eintrag vor. Die Seite ‹docs/routines.md› der Dokumentation beschreibt das Format jeder Datei einer Routine.`;
}

/**
 * Why the names could not be read with the account of `--credential`.
 *
 * @param code - Why the pipeline with the account was not built.
 * @returns One text.
 * @example
 * ```ts
 * accountText('token_file_missing');
 * ```
 */
export function accountText(code: AccountPipelineCode): string {
  const action = code.startsWith('runner_tokens_dir_')
    ? 'Richten Sie den Ordner aus ‹ECCLIUM_RUNNER_TOKENS_DIR› so ein, wie der Runner ihn braucht: ein Ordner Ihres Benutzers, kein Link, ohne Schreibrecht für die Gruppe und andere.'
    : 'Legen Sie die Token-Datei ‹ct_token_<Alias>› für den Alias aus ‹--credential› im Ordner aus ‹ECCLIUM_RUNNER_TOKENS_DIR› so an, wie der Runner sie braucht, mit den Rechten 600.';
  return `Ecclium liest die Namen mit dem Konto aus ‹--credential›, mit dem die Routine später schreibt, nie mit dem Token des Servers. ${runAccountCauses[code]} ${action} Rufen Sie den Befehl dann erneut auf.`;
}
