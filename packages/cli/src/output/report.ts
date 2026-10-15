/**
 * The report of `ecclium config check` in German (ADR 0055). It shows each
 * setting with its origin, the problems and the notices of the start, and
 * never a secret: the token only as «verborgen» with its source, never the
 * path of the token file and never a refused value. The host and a subject
 * other than the default are masked unless the operator asks for them, so
 * that the output fits into a public issue as it is.
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
  /** Shows the host and a subject other than the default. */
  readonly showValues: boolean;
}

const labels: Readonly<Record<SettingKey, string>> = Object.freeze({
  churchtoolsOrigin: 'ChurchTools-Adresse',
  churchtoolsToken: 'Token',
  readOnly: 'Nur lesen',
  redaction: 'Maskierung',
  searchTools: 'Suchtools',
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

interface Value {
  readonly text: string;
  readonly hides?: 'host' | 'subject';
}

const valueOf = (setting: SettingReport, showValues: boolean): Value => {
  if (setting.origin === 'missing') return { text: 'fehlt' };
  if (setting.origin === 'invalid') return { text: 'ungültig' };
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
    case 'origin': {
      // A port other than 443 stays visible: it names no instance.
      const port = shown.port === '' ? '' : `:${shown.port}`;
      return showValues
        ? { text: `https://${shown.host}${port}` }
        : { text: `https://${masked}${port}`, hides: 'host' };
    }
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
    case 'missing':
      return `${variable} ist nicht gesetzt`;
    case 'invalid':
      return `aus ${variable}, siehe die Probleme unten`;
  }
};

const maskedNote = (host: boolean, subject: boolean): string => {
  const [what, which] =
    host && subject
      ? ['Verborgen sind der Host und das Subjekt', 'beide']
      : host
        ? ['Verborgen ist der Host', 'ihn']
        : ['Verborgen ist das Subjekt', 'es'];
  return `${what}, damit Sie die Ausgabe ohne Bearbeitung weitergeben können. Mit ‹--show-values› zeigt der Befehl ${which}.`;
};

const validText =
  'Die Konfiguration ist gültig. ChurchTools wurde nicht angefragt. Ob das Token gilt, zeigt erst der Start.';

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
  let hidesHost = false;
  let hidesSubject = false;
  for (const setting of report.settings) {
    if (
      !Object.hasOwn(labels, setting.key) ||
      !(variableNames as readonly string[]).includes(setting.variable)
    ) {
      throw new TypeError(inconsistent);
    }
    const value = valueOf(setting, options.showValues);
    if (value.hides === 'host') hidesHost = true;
    if (value.hides === 'subject') hidesSubject = true;
    lines.push(
      `  ${labels[setting.key].padEnd(valueColumn)}${value.text} (${originOf(setting)})`,
    );
  }
  if (hidesHost || hidesSubject)
    lines.push(maskedNote(hidesHost, hidesSubject));

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
