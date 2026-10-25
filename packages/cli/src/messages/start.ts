/**
 * The German texts of the start over stdio (ADR 0055): a wrong call of
 * `ecclium stdio`, an internal error before the server runs, the refusal
 * of a plugin or a tool by the registry (ADR 0024), an audit file that is
 * missing or cannot be opened (ADR 0028), a folder for the read budget
 * that cannot be used (ADR 0063), and the toolsets of the start
 * (ADR 0062). The start notices write them to stderr before the line
 * writer exists. No text repeats an argument, because an argument can
 * hold a token, and the text of a refusal depends on its reason alone,
 * without the names of plugin and tool.
 *
 * @packageDocumentation
 */
import {
  type AuditFileCode,
  isToolsetName,
  type QuotaFolderCode,
  type RefusalReason,
  type ToolsetName,
} from '@ecclium/mcp-churchtools-core';

import type { Message, MessageText } from './config.js';

/** The texts of the start over stdio besides the refusals of the registry. */
export type StartNoticeCode = 'usage' | 'internal' | 'audit_file_required';

const message = (what: string, why: string, action: string): Message =>
  Object.freeze({ what, why, action });

const starts: Readonly<Record<StartNoticeCode, Message>> = Object.freeze({
  usage: message(
    'Der Befehl ‹ecclium stdio› nimmt keine weiteren Argumente an.',
    'Die Einstellungen kommen nur aus der Umgebung. Ecclium nennt die Argumente nicht, weil darin ein Token stehen könnte.',
    'Entfernen Sie alles nach ‹ecclium stdio› und setzen Sie die Einstellungen als Variablen in der Konfiguration des KI-Assistenten.',
  ),
  internal: message(
    'Der Start über stdio ist mit einem internen Fehler abgebrochen.',
    'Einzelheiten zeigt Ecclium nicht, weil sie Werte der Konfiguration enthalten könnten.',
    'Versuchen Sie es erneut und melden Sie den Fehler, wenn er bleibt.',
  ),
  audit_file_required: message(
    'Ein Tool mit Personendaten der besonderen Kategorie ist eingeschaltet, aber ‹ECCLIUM_STATE_DIR› ist nicht gesetzt.',
    'Ein Ergebnis eines solchen Tools gibt Ecclium nur heraus, wenn seine Zeile in der Audit-Datei steht, und die Audit-Datei liegt in diesem Ordner.',
    'Setzen Sie ‹ECCLIUM_STATE_DIR› auf einen lokalen Ordner Ihres Benutzers mit den Rechten 700 oder schalten Sie das Tool aus.',
  ),
});

const stateDir = '‹ECCLIUM_STATE_DIR›';
const configCheck = 'Prüfen Sie ihn mit «ecclium config check».';
const noPath =
  'Die Meldung des Dateisystems zeigt Ecclium nicht, weil sie den Pfad enthält.';

// One text per reason the audit file could not be opened. Each says that
// the start stops, because with the folder set the audit belongs into the
// file (ADR 0028).
const auditFiles: Readonly<Record<AuditFileCode, Message>> = Object.freeze({
  audit_file_platform: message(
    'Die Audit-Datei lässt sich auf diesem System nicht sicher anlegen, und der Start bricht ab.',
    'Es fehlt die Prüfung des Eigentümers oder das Öffnen ohne Links, etwa unter Windows.',
    `Entfernen Sie ${stateDir} auf diesem System.`,
  ),
  audit_file_folder_unavailable: message(
    `Ecclium konnte den Ordner ‹audit› im Ordner aus ${stateDir} nicht anlegen oder öffnen, und der Start bricht ab.`,
    `Ist ${stateDir} gesetzt, startet Ecclium nur mit der Audit-Datei. ${noPath}`,
    `Prüfen Sie, ob der Ordner aus ${stateDir} besteht und Ihr Benutzer darin schreiben darf.`,
  ),
  audit_file_folder_unsafe: message(
    `Der Ordner ‹audit› im Ordner aus ${stateDir} ist kein privater Ordner Ihres Benutzers, und der Start bricht ab.`,
    'Er ist ein Link, kein Ordner, gehört einem anderen Benutzer oder ist für andere zugänglich. Dann könnten andere die Audit-Datei lesen oder austauschen.',
    configCheck,
  ),
  audit_file_unavailable: message(
    'Ecclium konnte keine neue Audit-Datei anlegen, und der Start bricht ab.',
    `Das Dateisystem lehnte das Anlegen ab, etwa weil kein Platz mehr frei ist oder der Ordner nur gelesen werden kann. ${noPath}`,
    `Prüfen Sie freien Platz und Rechte im Ordner aus ${stateDir}.`,
  ),
  audit_file_unsafe: message(
    'Die neue Audit-Datei bestand die Prüfung nach dem Öffnen nicht, und der Start bricht ab.',
    'Sie war keine gewöhnliche Datei Ihres Benutzers, oder der Ordner änderte sich, während Ecclium sie öffnete.',
    `Prüfen Sie den Ordner aus ${stateDir} und starten Sie erneut.`,
  ),
});

// One text per reason the folder quota cannot be used. Each says that the
// start stops: without it, no tool with special data would run (ADR 0063).
const quotaFolders: Readonly<Record<QuotaFolderCode, Message>> = Object.freeze({
  quota_folder_platform: message(
    'Der Ordner für das Lesebudget lässt sich auf diesem System nicht sicher anlegen, und der Start bricht ab.',
    'Es fehlt die Prüfung des Eigentümers oder das Öffnen ohne Links, etwa unter Windows.',
    `Entfernen Sie ${stateDir} auf diesem System.`,
  ),
  quota_folder_unavailable: message(
    `Ecclium konnte den Ordner ‹quota› im Ordner aus ${stateDir} nicht anlegen oder öffnen, und der Start bricht ab.`,
    `Darin zählt Ecclium die Aufrufe der Tools mit Personendaten der besonderen Kategorie für das Lesebudget. ${noPath}`,
    `Prüfen Sie, ob der Ordner aus ${stateDir} besteht und Ihr Benutzer darin schreiben darf.`,
  ),
  quota_folder_unsafe: message(
    `Der Ordner ‹quota› im Ordner aus ${stateDir} ist kein privater Ordner Ihres Benutzers, und der Start bricht ab.`,
    'Er ist ein Link, kein Ordner, gehört einem anderen Benutzer oder ist für andere zugänglich. Dann könnten andere die Zähler des Lesebudgets ändern.',
    configCheck,
  ),
});

// Every refusal stops the start for the same reason, and none comes from
// the configuration: in this version the only plugin is the one of the
// core.
const refusalWhy =
  'Ecclium startet deshalb nicht: Ein Server ohne die erwarteten Tools liefe sonst, ohne dass es jemand merkt.';
const refusalAction =
  'Das ist ein Fehler in Ecclium oder in einem Plugin, nicht in Ihrer Konfiguration. Melden Sie ihn mit dem Wortlaut dieser Meldung.';

const refusal = (what: string): Message =>
  message(what, refusalWhy, refusalAction);

const refusals: Readonly<Record<RefusalReason, Message>> = Object.freeze({
  plugin_invalid: refusal(
    'Ein Plugin hat keinen gültigen Namen, keine gültige Version oder keine Funktion, die seine Tools registriert.',
  ),
  plugin_reserved: refusal(
    'Ein Plugin trägt den Namen, der dem Kern von Ecclium vorbehalten ist.',
  ),
  plugin_duplicate: refusal('Zwei Plugins tragen denselben Namen.'),
  plugin_threw: refusal(
    'Ein Plugin ist mit einem Fehler abgebrochen, während es seine Tools registrierte.',
  ),
  plugin_async: refusal(
    'Ein Plugin hat seine Tools asynchron registriert statt sofort.',
  ),
  host_revoked: refusal(
    'Ein Plugin hat ein Tool hinzugefügt, nachdem seine Registrierung beendet war.',
  ),
  tool_invalid: refusal(
    'Ein Tool ist kein Objekt mit den Feldern eines Tools.',
  ),
  tool_name: refusal('Ein Tool trägt einen Namen, der nicht erlaubt ist.'),
  tool_duplicate: refusal('Zwei Tools tragen denselben Namen.'),
  tool_meta: refusal(
    'Ein Tool hat unvollständige oder widersprüchliche Metadaten.',
  ),
  tool_domain_reserved: refusal(
    'Ein Tool eines Plugins liegt im Bereich ‹base›, der dem Kern vorbehalten ist.',
  ),
  tool_description: refusal(
    'In der Beschreibung eines Tools fehlt ein Abschnitt, oder ein Abschnitt ist ungültig.',
  ),
  tool_input: refusal(
    'Das Eingabeschema eines Tools ist kein geschlossenes Objekt oder lässt sich nicht als JSON Schema melden.',
  ),
  tool_output: refusal(
    'Das Ausgabeschema eines Tools erfüllt die Regeln für Tools nicht.',
  ),
  tool_sensitivity: refusal(
    'Ein Tool gibt eine niedrigere Sensibilität an, als die Datenklassen seiner Ausgabe verlangen.',
  ),
  tool_unclassified: refusal(
    'Das Ausgabeschema eines Tools hat ein Feld ohne Datenklasse.',
  ),
  tool_unmasked: refusal(
    'Das Ausgabeschema eines Tools hat ein Feld einer Datenklasse, die der Kern noch nicht maskieren kann.',
  ),
  description_budget: refusal(
    'Die Beschreibungen aller Tools sind zusammen länger als erlaubt.',
  ),
});

// The three parts as one text. Not exported: a caller could otherwise
// turn any object with three strings into a text of the catalog.
const joined = (parts: Message): MessageText =>
  `${parts.what} ${parts.why} ${parts.action}` as MessageText;

/**
 * The message for a text of the start over stdio: a wrong call of
 * `ecclium stdio` or an internal error before the server runs.
 *
 * @param code - Which text.
 * @returns The message in its three parts, frozen.
 * @throws {TypeError} When the code is none of the catalog.
 * @example
 * ```ts
 * startMessage('usage').action;
 * ```
 */
export function startMessage(code: StartNoticeCode): Message {
  const given: unknown = code;
  if (typeof given !== 'string' || !Object.hasOwn(starts, given)) {
    throw new TypeError('The start code is unknown.');
  }
  return starts[code];
}

/**
 * The text for a wrong call of `ecclium stdio` or an internal error before
 * the server runs, in one line.
 *
 * @param code - Which text.
 * @returns The text of the catalog.
 * @throws {TypeError} When the code is none of the catalog.
 * @example
 * ```ts
 * writeNotices([startText('internal')]);
 * ```
 */
export function startText(code: StartNoticeCode): MessageText {
  return joined(startMessage(code));
}

/**
 * The message for an audit file that could not be opened. It names no
 * path.
 *
 * @param code - Why the file could not be opened.
 * @returns The message in its three parts, frozen.
 * @throws {TypeError} When the code is none of the catalog.
 * @example
 * ```ts
 * auditFileMessage('audit_file_unavailable').action;
 * ```
 */
export function auditFileMessage(code: AuditFileCode): Message {
  const given: unknown = code;
  if (typeof given !== 'string' || !Object.hasOwn(auditFiles, given)) {
    throw new TypeError('The audit file code is unknown.');
  }
  return auditFiles[code];
}

/**
 * The text for an audit file that could not be opened, in one line.
 *
 * @param code - Why the file could not be opened.
 * @returns The text of the catalog.
 * @throws {TypeError} When the code is none of the catalog.
 * @example
 * ```ts
 * writeNotices([auditFileText('audit_file_unsafe')]);
 * ```
 */
export function auditFileText(code: AuditFileCode): MessageText {
  return joined(auditFileMessage(code));
}

/**
 * The message for a folder `quota` that cannot be used. It names no path.
 *
 * @param code - Why the folder cannot be used.
 * @returns The message in its three parts, frozen.
 * @throws {TypeError} When the code is none of the catalog.
 * @example
 * ```ts
 * quotaFolderMessage('quota_folder_unsafe').action;
 * ```
 */
export function quotaFolderMessage(code: QuotaFolderCode): Message {
  const given: unknown = code;
  if (typeof given !== 'string' || !Object.hasOwn(quotaFolders, given)) {
    throw new TypeError('The quota folder code is unknown.');
  }
  return quotaFolders[code];
}

/**
 * The text for a folder `quota` that cannot be used, in one line.
 *
 * @param code - Why the folder cannot be used.
 * @returns The text of the catalog.
 * @throws {TypeError} When the code is none of the catalog.
 * @example
 * ```ts
 * writeNotices([quotaFolderText('quota_folder_unsafe')]);
 * ```
 */
export function quotaFolderText(code: QuotaFolderCode): MessageText {
  return joined(quotaFolderMessage(code));
}

/**
 * The message for a refusal of the registry. It depends on the reason
 * alone and names neither the plugin nor the tool.
 *
 * @param reason - Why the registry refused.
 * @returns The message in its three parts, frozen.
 * @throws {TypeError} When the reason is none of the catalog, such as
 *   toString.
 * @example
 * ```ts
 * refusalMessage('plugin_reserved').what;
 * ```
 */
export function refusalMessage(reason: RefusalReason): Message {
  const given: unknown = reason;
  if (typeof given !== 'string' || !Object.hasOwn(refusals, given)) {
    throw new TypeError('The refusal reason is unknown.');
  }
  return refusals[reason];
}

/**
 * The text for a refusal of the registry, in one line.
 *
 * @param reason - Why the registry refused.
 * @returns The text of the catalog.
 * @throws {TypeError} When the reason is none of the catalog.
 * @example
 * ```ts
 * refusalText('tool_input');
 * ```
 */
export function refusalText(reason: RefusalReason): MessageText {
  return joined(refusalMessage(reason));
}

const toolsetsVariable = '‹ECCLIUM_TOOLSETS›';

// Names of toolsets as German prose: ‹a›, ‹b› und ‹c›. Only a name of the
// list of toolsets reaches a text, and at least one.
const toolsetProse = (toolsets: unknown): string => {
  if (
    !Array.isArray(toolsets) ||
    toolsets.length === 0 ||
    !toolsets.every(isToolsetName)
  ) {
    throw new TypeError('The toolsets are unknown.');
  }
  const quoted = toolsets.map((name) => `‹${name}›`);
  const last = quoted.pop() ?? '';
  return quoted.length === 0 ? last : `${quoted.join(', ')} und ${last}`;
};

/**
 * The message that names the toolsets of the start (ADR 0062). Without a
 * toolset the start says nothing, as the reference of the configuration
 * names the default.
 *
 * @param toolsets - The toolsets of the configuration, at least one.
 * @returns The message in its three parts, frozen.
 * @throws {TypeError} When the list is no array, is empty or holds a name
 *   that is no toolset.
 * @example
 * ```ts
 * toolsetsMessage(['persons', 'wiki']).what;
 * // 'Eingeschaltet sind die Toolsets ‹persons› und ‹wiki›.'
 * ```
 */
export function toolsetsMessage(toolsets: readonly ToolsetName[]): Message {
  const names = toolsetProse(toolsets);
  return message(
    toolsets.length === 1
      ? `Eingeschaltet ist das Toolset ${names}.`
      : `Eingeschaltet sind die Toolsets ${names}.`,
    `Der Server bietet neben ‹ct_whoami› nur ${toolsets.length === 1 ? 'seine' : 'ihre'} Tools an.`,
    `Ändern Sie ${toolsetsVariable}, wenn der KI-Assistent andere Bereiche lesen soll.`,
  );
}

/**
 * The text that names the toolsets of the start, in one line.
 *
 * @param toolsets - The toolsets of the configuration, at least one.
 * @returns The text of the catalog.
 * @throws {TypeError} When the list is no array, is empty or holds a name
 *   that is no toolset.
 * @example
 * ```ts
 * writeNotices([toolsetsText(config.toolsets)]);
 * ```
 */
export function toolsetsText(toolsets: readonly ToolsetName[]): MessageText {
  return joined(toolsetsMessage(toolsets));
}

/**
 * The message for a toolset that is on but offers no tool in this
 * version, so that it does not stay silent (ADR 0062): it brings none yet,
 * or only tools that write while the server only reads.
 *
 * @param toolset - The toolset without a tool.
 * @returns The message in its three parts, frozen.
 * @throws {TypeError} When the name is no toolset.
 * @example
 * ```ts
 * emptyToolsetMessage('songs').what;
 * ```
 */
export function emptyToolsetMessage(toolset: ToolsetName): Message {
  const name = toolsetProse([toolset]);
  return message(
    `Das Toolset ${name} bietet in dieser Version keine Tools an.`,
    'Seine Tools kommen mit einer späteren Version, oder es hat nur Tools, die schreiben, und der Server liest nur.',
    `Lassen Sie es eingeschaltet, wenn eine spätere Version seine Tools anbieten soll. Sonst entfernen Sie es aus ${toolsetsVariable}, und steht dort ‹all›, nennen Sie stattdessen die übrigen Toolsets einzeln.`,
  );
}

/**
 * The text for a toolset without a tool, in one line.
 *
 * @param toolset - The toolset without a tool.
 * @returns The text of the catalog.
 * @throws {TypeError} When the name is no toolset.
 * @example
 * ```ts
 * writeNotices([emptyToolsetText('songs')]);
 * ```
 */
export function emptyToolsetText(toolset: ToolsetName): MessageText {
  return joined(emptyToolsetMessage(toolset));
}
