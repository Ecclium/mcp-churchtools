/**
 * The German texts of the start over stdio (ADR 0055): a wrong call of
 * `ecclium stdio`, an internal error before the server runs, and the
 * refusal of a plugin or a tool by the registry (ADR 0024). The start
 * notices write them to stderr before the line writer exists. No text
 * repeats an argument, because an argument can hold a token, and the text
 * of a refusal depends on its reason alone, without the names of plugin
 * and tool.
 *
 * @packageDocumentation
 */
import type { RefusalReason } from '@ecclium/mcp-churchtools-core';

import type { Message, MessageText } from './config.js';

/** The texts of the start over stdio besides the refusals of the registry. */
export type StartNoticeCode = 'usage' | 'internal';

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
