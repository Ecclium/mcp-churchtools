/**
 * The report of `ecclium config check` in German (ADR 0055). It shows each
 * setting with its origin, the problems and the notices of the start, and
 * never a secret: the token only as «verborgen» with its source, never the
 * path of the token file and never a refused value. The host, a subject
 * other than the default and the folder of state are masked unless the
 * operator asks for them, so that the output fits into a public issue as
 * it is.
 *
 * @packageDocumentation
 */
import {
  type ConfigReport,
  defaultStdioSubject,
  type SettingKey,
  type SettingReport,
  type Transport,
  variableNames,
} from '@ecclium/mcp-churchtools-core';

import { formatNumber, problemText, warningText } from '../messages/index.js';

/** Options of {@link renderConfigReport}. */
export interface ReportOptions {
  /** Whether the loader found the configuration valid. */
  readonly valid: boolean;
  /**
   * Shows the host, a subject other than the default and the folder of
   * state.
   */
  readonly showValues: boolean;
}

const labels: Readonly<Record<SettingKey, string>> = Object.freeze({
  churchtoolsOrigin: 'ChurchTools-Adresse',
  churchtoolsToken: 'Token',
  churchtoolsRequestsPerMinute: 'Anfragen je Minute',
  readOnly: 'Nur lesen',
  redaction: 'Maskierung',
  toolsets: 'Toolsets',
  stateDir: 'Zustandsordner',
  auditRetentionMonths: 'Frist in Monaten',
  stdioSubject: 'Subjekt über stdio',
  logLevel: 'Stufe des Logs',
});

// The values start in one column, two spaces after the longest label.
const valueColumn =
  Math.max(...Object.values(labels).map((label) => label.length)) + 2;

const transports: Readonly<Record<Transport, string>> = Object.freeze({
  stdio: 'über stdio',
  http: 'über HTTP',
});

const masked = '[verborgen]';

const quote = (text: string): string => `‹${text}›`;

const inconsistent = 'The report of the configuration is inconsistent.';

type Hidden = 'host' | 'subject' | 'path';

interface Value {
  readonly text: string;
  readonly hides?: Hidden;
}

// A path is shown only in printable ASCII. Anything else could be a
// character the writer refuses, which would drop the whole line silently,
// or one that changes how a terminal shows the line.
const isPrintable = (text: string): boolean => {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x20 || code > 0x7e) return false;
  }
  return text.length > 0;
};

const valueOf = (setting: SettingReport, showValues: boolean): Value => {
  if (setting.origin === 'missing') return { text: 'fehlt' };
  if (setting.origin === 'invalid') return { text: 'ungültig' };
  // Only the folder of state may stay unset without a default.
  if (setting.origin === 'unset') {
    if (setting.key !== 'stateDir') throw new TypeError(inconsistent);
    return { text: 'keine Audit-Datei' };
  }
  const shown = setting.shown;
  switch (shown.kind) {
    case 'boolean':
      return { text: shown.value ? 'ja' : 'nein' };
    case 'choice':
      // Any subject but the default could be the name of a person.
      return setting.key === 'stdioSubject' &&
        shown.value !== defaultStdioSubject &&
        !showValues
        ? { text: masked, hides: 'subject' }
        : { text: quote(shown.value) };
    case 'list':
      return {
        text:
          shown.values.length === 0
            ? 'keine'
            : shown.values.map(quote).join(', '),
      };
    case 'integer':
      return { text: formatNumber(shown.value) };
    case 'origin': {
      // A port other than 443 stays visible: it names no instance.
      const port = shown.port === '' ? '' : `:${shown.port}`;
      return showValues
        ? { text: `https://${shown.host}${port}` }
        : { text: `https://${masked}${port}`, hides: 'host' };
    }
    case 'path':
      // The path can hold the name of a user, so it is masked by default.
      if (!showValues) return { text: masked, hides: 'path' };
      return isPrintable(shown.value)
        ? { text: quote(shown.value) }
        : { text: 'gesetzt' };
    case 'hidden':
      return { text: 'verborgen' };
    case 'none':
      throw new TypeError(inconsistent);
  }
};

const originOf = (setting: SettingReport): string => {
  const variable = quote(setting.variable);
  switch (setting.origin) {
    case 'default':
      return 'Voreinstellung';
    case 'environment':
      return `aus ${variable}`;
    case 'file':
      return `aus der Datei in ${variable}, Eigentümer und Dateirechte geprüft`;
    case 'unset':
    case 'missing':
      return `${variable} ist nicht gesetzt`;
    case 'invalid':
      return `aus ${variable}, siehe die Probleme unten`;
  }
};

// What a masked value is called, with the pronoun that stands for it.
const hiddenNames: Readonly<Record<Hidden, readonly [string, string]>> =
  Object.freeze({
    host: ['der Host', 'ihn'],
    subject: ['das Subjekt', 'es'],
    path: ['der Zustandsordner', 'ihn'],
  });

const maskedNote = (hidden: readonly Hidden[]): string => {
  const names = hidden.map((entry) => hiddenNames[entry][0]);
  const last = names.pop() ?? '';
  const what =
    names.length === 0
      ? `Verborgen ist ${last}`
      : `Verborgen sind ${names.join(', ')} und ${last}`;
  const which =
    names.length === 0
      ? hiddenNames[hidden[0] ?? 'host'][1]
      : names.length === 1
        ? 'beide'
        : 'alle';
  return `${what}, damit Sie die Ausgabe ohne Bearbeitung weitergeben können. Mit ‹--show-values› zeigt der Befehl ${which}.`;
};

const validText =
  'Die Konfiguration ist gültig. ChurchTools wurde nicht angefragt. Ob ChurchTools das Token annimmt, zeigt erst ein Aufruf von ‹ct_whoami›.';

const invalidText =
  'Mit dieser Konfiguration startet Ecclium nicht. ChurchTools wurde nicht angefragt. Beheben Sie die Probleme und prüfen Sie dann erneut mit ‹ecclium config check›.';

/**
 * Renders the report of the loader as lines for a terminal: a heading,
 * one line per setting, then the problems, the notices of the start and
 * the result. Nothing is written here.
 *
 * @param report - The report of the loader.
 * @param options - Whether the configuration is valid and whether the
 *   masked values are shown.
 * @returns The lines, frozen.
 * @throws {TypeError} When the report names an unknown setting or
 *   variable, or shows nothing for a setting that has a value.
 * @example
 * ```ts
 * const lines = renderConfigReport(result.report, { valid: result.ok, showValues: false });
 * ```
 */
export function renderConfigReport(
  report: ConfigReport,
  options: ReportOptions,
): readonly string[] {
  if (!Object.hasOwn(transports, report.transport)) {
    throw new TypeError(inconsistent);
  }
  const lines = [
    `Prüfung der Konfiguration für den Betrieb ${transports[report.transport]}`,
  ];
  const hidden = new Set<Hidden>();
  for (const setting of report.settings) {
    if (
      !Object.hasOwn(labels, setting.key) ||
      !(variableNames as readonly string[]).includes(setting.variable)
    ) {
      throw new TypeError(inconsistent);
    }
    const value = valueOf(setting, options.showValues);
    if (value.hides !== undefined) hidden.add(value.hides);
    lines.push(
      `  ${labels[setting.key].padEnd(valueColumn)}${value.text} (${originOf(setting)})`,
    );
  }
  if (hidden.size > 0) {
    // In the order of the note, whatever the order of the settings.
    lines.push(
      maskedNote(
        (['host', 'subject', 'path'] as const).filter((entry) =>
          hidden.has(entry),
        ),
      ),
    );
  }

  const total = report.problems.length + report.omittedProblems;
  if (total > 0) {
    lines.push(
      total === 1
        ? 'Die Konfiguration hat 1 Problem:'
        : `Die Konfiguration hat ${formatNumber(total)} Probleme:`,
    );
    for (const problem of report.problems) {
      lines.push(`  - ${problemText(problem)}`);
    }
    if (report.omittedProblems > 0) {
      lines.push(
        `  und ${formatNumber(report.omittedProblems)} ${report.omittedProblems === 1 ? 'weiteres' : 'weitere'}`,
      );
    }
  }
  if (report.warnings.length > 0) {
    lines.push('Beim Start meldet Ecclium:');
    for (const code of report.warnings) {
      lines.push(`  - ${warningText(code)}`);
    }
  }
  lines.push(options.valid ? validText : invalidText);
  return Object.freeze(lines);
}
