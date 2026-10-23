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
 * variableDescriptions.ECCLIUM_READ_ONLY; // 'Legt fest, ob der Server …'
 * ```
 */
export const variableDescriptions: Readonly<Record<VariableName, string>> =
  Object.freeze({
    __proto__: null,
    ECCLIUM_CHURCHTOOLS_URL:
      'Adresse der ChurchTools-Instanz, nur mit `https`, ohne Pfad und in Kleinbuchstaben, etwa `https://example.church.tools`. Eine IP-Adresse oder `localhost` nimmt Ecclium nicht an. Der Server verbindet sich nur mit genau dieser Adresse. Pflicht.',
    ECCLIUM_CHURCHTOOLS_TOKEN_FILE:
      'Absoluter Pfad einer Datei mit dem Login-Token des Dienstkontos. Die Datei muss dem Benutzer gehören, unter dem Ecclium läuft, und für die Gruppe und andere Benutzer keine Rechte haben, etwa mit den Rechten 600. Pflicht, ausser im Betrieb über stdio mit `ECCLIUM_CHURCHTOOLS_TOKEN`.',
    ECCLIUM_CHURCHTOOLS_TOKEN:
      'Das Login-Token selbst statt einer Datei, nur im Betrieb über stdio und mit einer Warnung beim Start. Sicherer ist die Token-Datei. Beides zugleich bricht den Start ab.',
    ECCLIUM_CHURCHTOOLS_REQUESTS_PER_MINUTE:
      'Legt fest, wie viele Anfragen der Server im Mittel höchstens pro Minute an ChurchTools sendet. Die Drosselung zählt je ChurchTools-Instanz und Prozess selbst. Ist ihr Kontingent erschöpft, endet ein Aufruf sofort mit `rate_limited`.',
    ECCLIUM_READ_ONLY:
      'Legt fest, ob der Server nur liest. Mit `true` registriert er keine Schreib-Tools. In dieser Version gibt es noch keine Schreib-Tools.',
    ECCLIUM_REDACTION:
      'Stufe der Maskierung. `standard` maskiert E-Mail-Adressen, Telefonnummern und Geburtsdaten. `off` schaltet die Masken ab, nur im Betrieb über stdio und mit einer Warnung beim Start. `strict` bricht den Start ab, bis die vollständige Maskierung steht.',
    ECCLIUM_SEARCH_TOOLS:
      'Mit `true` bietet der Server die Suchtools `ct_persons_search` und `ct_groups_search` an. Sie verlangen `ECCLIUM_STATE_DIR` für die Audit-Datei, sonst startet der Server über stdio nicht.',
    ECCLIUM_STATE_DIR:
      'Absoluter Pfad eines Ordners für den Zustand des Servers, heute für die Audit-Datei im Unterordner `audit`. Den Ordner selbst legt Ecclium nicht an, den Unterordner darin schon. Der Ordner muss dem Benutzer gehören, unter dem Ecclium läuft, und für die Gruppe und andere Benutzer keine Rechte haben, etwa mit den Rechten 700. Nur im Betrieb über stdio.',
    ECCLIUM_STDIO_SUBJECT:
      'Das Subjekt, also eine neutrale Bezeichnung dessen, der den Server über stdio nutzt. Erlaubt sind Kleinbuchstaben, Ziffern und Bindestriche, am Anfang ein Buchstabe. Die Bezeichnung erscheint im Audit als Akteur und darf deshalb kein Personenname sein.',
    ECCLIUM_LOG_LEVEL:
      'Legt fest, ab welcher Stufe der Server Zeilen des Logs auf stderr schreibt.',
  });
