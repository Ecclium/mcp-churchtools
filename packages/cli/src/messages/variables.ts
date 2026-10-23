/**
 * What each variable of the configuration does, in German for operators.
 * The generated reference `docs/configuration.md` shows these texts next to
 * the table of the variables in the core (ADR 0055), which has no text for
 * people.
 *
 * @packageDocumentation
 */
import type { VariableName } from '@ecclium/mcp-churchtools-core';

/**
 * One description per variable, frozen. A test makes sure that every
 * variable of the table has one.
 *
 * @example
 * ```ts
 * variableDescriptions.ECCLIUM_READ_ONLY; // 'Ob der Server nur liest. …'
 * ```
 */
export const variableDescriptions: Readonly<Record<VariableName, string>> =
  Object.freeze({
    __proto__: null,
    ECCLIUM_CHURCHTOOLS_URL:
      'Adresse der ChurchTools-Instanz, nur mit `https`, ohne Pfad und in Kleinbuchstaben, etwa `https://example.church.tools`. Der Server verbindet sich nur mit genau dieser Adresse.',
    ECCLIUM_CHURCHTOOLS_TOKEN_FILE:
      'Absoluter Pfad einer Datei mit dem Login-Token des Dienstkontos. Die Datei muss dem Benutzer gehören, unter dem Ecclium läuft, und darf für die Gruppe und andere Benutzer nicht lesbar sein.',
    ECCLIUM_CHURCHTOOLS_TOKEN:
      'Das Login-Token selbst statt einer Datei, nur im Betrieb über stdio und mit einer Warnung beim Start. Sicherer ist die Token-Datei. Beides zugleich bricht den Start ab.',
    ECCLIUM_CHURCHTOOLS_REQUESTS_PER_MINUTE:
      'Wie viele Anfragen der Server höchstens pro Minute an ChurchTools sendet. Die Drosselung zählt je Instanz selbst, weil ChurchTools seine Grenze nicht meldet.',
    ECCLIUM_READ_ONLY:
      'Ob der Server nur liest. Mit `true` registriert er keine Schreib-Tools. In dieser Version gibt es noch keine Schreib-Tools.',
    ECCLIUM_REDACTION:
      'Stufe der Maskierung. `standard` maskiert E-Mail-Adressen, Telefonnummern und Geburtsdaten. `off` schaltet die Masken ab, nur im Betrieb über stdio und mit einer Warnung beim Start. `strict` bricht den Start ab, bis die vollständige Maskierung steht.',
    ECCLIUM_SEARCH_TOOLS:
      'Mit `true` bietet der Server die Suchtools `ct_persons_search` und `ct_groups_search` an. Sie verlangen `ECCLIUM_STATE_DIR` für die Audit-Datei.',
    ECCLIUM_STATE_DIR:
      'Absoluter Pfad eines Ordners für den Zustand des Servers, heute für die Audit-Datei im Unterordner `audit`. Ecclium legt den Ordner nicht selbst an. Er muss dem Benutzer gehören, unter dem Ecclium läuft, und die Rechte 700 haben. Nur im Betrieb über stdio.',
    ECCLIUM_STDIO_SUBJECT:
      'Neutrale Bezeichnung dessen, der den Server über stdio nutzt. Sie erscheint im Audit als Akteur und ist deshalb nie ein Personenname.',
    ECCLIUM_LOG_LEVEL:
      'Ab welcher Stufe der Server Zeilen in sein Log nach stderr schreibt.',
  });
