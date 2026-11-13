/**
 * The report of `ecclium config check` in German (ADR 0055). It shows each
 * setting with its origin, the problems and the notices of the start, and
 * never a secret: the token only as «verborgen» with its source, never the
 * path of the token file and never a refused value. The host, a subject
 * other than the default and the folders of state and of keys are masked
 * unless the operator asks for them, so that the output fits into a public
 * issue as it is.
 *
 * @packageDocumentation
 */
import {
  type ConfigReport,
  defaultStdioSubject,
  type Policy,
  policyHashOf,
  policyLimits,
  type ProviderSettings,
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
   * Shows the host, a subject other than the default and the folders of
   * state and of keys.
   */
  readonly showValues: boolean;
  /**
   * The checked policy of a valid configuration, for its summary: the
   * number of entries, the read budget, the hash and the findings that a
   * later `ecclium doctor` will report (ADR 0032). Never a target.
   */
  readonly policy?: Policy | undefined;
  /**
   * The checked providers of a valid configuration, for their summary:
   * alias, vendor, model, country and basis of transfer, the host of the
   * endpoint only with `showValues` (ADR 0033). Never the path of a key.
   */
  readonly providers?: readonly ProviderSettings[] | undefined;
  /**
   * Leaves out the last line, which speaks of the server and `ct_whoami`;
   * the check of the runner ends with its own (ADR 0033).
   */
  readonly withoutEnding?: boolean;
}

const labels: Readonly<Record<SettingKey, string>> = Object.freeze({
  churchtoolsOrigin: 'ChurchTools-Adresse',
  churchtoolsToken: 'Token',
  churchtoolsRequestsPerMinute: 'Anfragen je Minute',
  readOnly: 'Nur lesen',
  redaction: 'Maskierung',
  pseudonymKey: 'Pseudonym-Schlüssel',
  pseudonymKeyPrevious: 'Früherer Schlüssel',
  toolsets: 'Toolsets',
  stateDir: 'Zustandsordner',
  keysDir: 'Schlüsselordner',
  snapshots: 'Snapshots',
  writeConfirmation: 'Bestätigung',
  timeZone: 'Zeitzone der Texte',
  auditRetentionMonths: 'Frist in Monaten',
  policy: 'Richtlinie',
  markerKey: 'Prüfcode-Schlüssel',
  routinesDir: 'Ordner der Routinen',
  providers: 'Modellanbieter',
  runnerTokensDir: 'Token des Runners',
  draftsDir: 'Ordner der Entwürfe',
  notifyFile: 'Datei der Meldungen',
  metricsFile: 'Metrikdatei',
  runnerPingUrl: 'Ping-URL',
  egressProxy: 'Proxy nach aussen',
  egress: 'Grenze im Netz',
  egressAllowLan: 'Ziele im LAN',
  stdioSubject: 'Subjekt über stdio',
  logLevel: 'Stufe des Logs',
});

// The values start in one column, two spaces after the longest label.
const valueColumn =
  Math.max(...Object.values(labels).map((label) => label.length)) + 2;

const transports: Readonly<Record<Transport, string>> = Object.freeze({
  stdio: 'über stdio',
  http: 'über HTTP',
  runner: 'des Runners',
});

const masked = '[verborgen]';

const quote = (text: string): string => `‹${text}›`;

const inconsistent = 'The report of the configuration is inconsistent.';

type Hidden =
  | 'host'
  | 'subject'
  | 'path'
  | 'keys'
  | 'policy'
  | 'routines'
  | 'providers'
  | 'tokens'
  | 'drafts'
  | 'notices'
  | 'metrics'
  | 'ping';

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
  // Without a file the default policy applies, which has no value to show
  // (ADR 0032).
  if (setting.key === 'policy' && setting.origin === 'default') {
    return { text: 'keine Datei' };
  }
  // Only the folders of state, of keys, of the routines, of the tokens of
  // the runner and of the drafts, the files of the providers, of the
  // notices, of the metrics and of the ping, the key files, the zone, the
  // proxy, the switch for a runner without it and the targets in the local
  // network may stay unset without a default.
  if (setting.origin === 'unset') {
    switch (setting.key) {
      case 'timeZone':
        return { text: 'UTC' };
      case 'stateDir':
        return { text: 'keine Audit-Datei' };
      case 'keysDir':
        return { text: 'keine Tagesschlüssel' };
      case 'pseudonymKey':
        return { text: 'kein Schlüssel' };
      case 'pseudonymKeyPrevious':
        return { text: 'kein Wechsel' };
      case 'markerKey':
        return { text: 'kein Schlüssel' };
      case 'routinesDir':
        return { text: 'keine Routinen' };
      case 'providers':
        return { text: 'keine Anbieter' };
      case 'runnerTokensDir':
        return { text: 'kein Ordner' };
      case 'draftsDir':
        return { text: 'keine Entwürfe als Datei' };
      case 'notifyFile':
        return { text: 'keine Meldungen als Datei' };
      case 'metricsFile':
        return { text: 'keine Metrikdatei' };
      case 'runnerPingUrl':
        return { text: 'kein Ping' };
      case 'egressProxy':
        return { text: 'kein Proxy' };
      case 'egress':
        return { text: 'nicht abgeschaltet' };
      case 'egressAllowLan':
        return { text: 'keine' };
      default:
        throw new TypeError(inconsistent);
    }
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
      // A port other than 443 stays visible: it names no instance. The
      // address of the ping shows no path, which works like a secret
      // (ADR 0009), and its host is masked like that of ChurchTools.
      const port = shown.port === '' ? '' : `:${shown.port}`;
      return showValues
        ? { text: `https://${shown.host}${port}` }
        : {
            text: `https://${masked}${port}`,
            hides: setting.key === 'runnerPingUrl' ? 'ping' : 'host',
          };
    }
    case 'targets':
      // Like the address of ChurchTools: the name of a target can name
      // an instance or a machine of the network, its port names none.
      return showValues
        ? {
            text: shown.values
              .map(({ host, port }) => quote(`${host}:${port}`))
              .join(', '),
          }
        : {
            text: shown.values
              .map(({ port }) => `${masked}:${port}`)
              .join(', '),
            hides: 'host',
          };
    case 'proxy':
      // The host of the proxy can name a machine of the network; the port
      // names none (ADR 0035).
      return showValues
        ? { text: `http://${shown.host}:${shown.port}` }
        : { text: `http://${masked}:${shown.port}`, hides: 'host' };
    case 'path':
      // The path can hold the name of a user, so it is masked by default.
      if (!showValues) {
        return {
          text: masked,
          hides:
            setting.key === 'policy'
              ? 'policy'
              : setting.key === 'keysDir'
                ? 'keys'
                : setting.key === 'routinesDir'
                  ? 'routines'
                  : setting.key === 'providers'
                    ? 'providers'
                    : setting.key === 'runnerTokensDir'
                      ? 'tokens'
                      : setting.key === 'draftsDir'
                        ? 'drafts'
                        : setting.key === 'notifyFile'
                          ? 'notices'
                          : setting.key === 'metricsFile'
                            ? 'metrics'
                            : 'path',
        };
      }
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
    keys: ['der Schlüsselordner', 'ihn'],
    policy: ['der Pfad der Richtlinie', 'ihn'],
    routines: ['der Ordner der Routinen', 'ihn'],
    providers: ['der Pfad der Datei der Anbieter', 'ihn'],
    tokens: ['der Ordner der Token des Runners', 'ihn'],
    drafts: ['der Ordner der Entwürfe', 'ihn'],
    notices: ['der Pfad der Datei der Meldungen', 'ihn'],
    metrics: ['der Pfad der Metrikdatei', 'ihn'],
    ping: ['der Host der Ping-URL', 'ihn'],
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

const entries = (count: number): string =>
  count === 0
    ? 'keine Einträge'
    : count === 1
      ? '1 Eintrag'
      : `${formatNumber(count)} Einträge`;

// The summary of the policy: its hash, as every audit line of a write
// names it, the size of both parts and the read budget, then what a later
// `ecclium doctor` reports as findings (ADR 0032). No target, so that the
// output fits into a public issue as well.
const policyLines = (policy: Policy): readonly string[] => {
  const budget = policy.interactive.readBudgetPerDay;
  const row = (label: string, value: string): string =>
    `  ${label.padEnd(valueColumn)}${value}`;
  const lines = [
    `Richtlinie im Format ‹policy.v1›, Hash ${policyHashOf(policy)}:`,
    row('Interaktiv', entries(policy.interactive.targets.length)),
    row(
      'Für Routinen',
      `${entries(policy.unattended.length)}, sie gelten erst mit dem Runner`,
    ),
    row('Lesebudget', `${formatNumber(budget)} Aufrufe je Akteur und UTC-Tag`),
  ];
  if (policy.interactive.targets.length === 0) {
    lines.push(
      '  Befund: Der interaktive Teil hat keine Einträge. Bestätigte Schreibvorgänge dürfen dann auf jedes Ziel, das das Dienstkonto schreiben darf, ausser bei Gruppen und Diensten. Empfohlen sind Einträge für die Ziele, auf die Ecclium schreiben soll.',
    );
  }
  if (budget === 0) {
    lines.push(
      '  Befund: Das Lesebudget ist 0. Tools mit besonders schützenswerten Daten und Tools, die Personen nennen, laufen dann nicht.',
    );
  } else if (budget > policyLimits.defaultReadBudgetPerDay) {
    lines.push(
      `  Befund: Das Lesebudget liegt über der Voreinstellung von ${formatNumber(policyLimits.defaultReadBudgetPerDay)} Aufrufen. Der KI-Assistent kann dann mehr Personendaten lesen, bevor die Grenze greift.`,
    );
  }
  return lines;
};

// The summary of the providers: per alias the vendor, the model, the
// country and, outside Switzerland and the EEA, the basis of the transfer,
// so that the operator sees where the data of a run go (ADR 0033). The
// host of the endpoint can name a server of the parish, so it shows only
// on request, and the path of a key never.
const providerLines = (
  providers: readonly ProviderSettings[],
  showValues: boolean,
): readonly string[] => [
  'Anbieter von Sprachmodellen im Format ‹providers.v1›:',
  ...providers.map(({ alias, info }) => {
    const parts = [
      info.vendor,
      `Modell ${quote(info.model)}`,
      `Land ${info.hostingCountry}`,
      ...(info.transferBasis === undefined
        ? []
        : [`Grundlage ${quote(info.transferBasis)}`]),
      ...(showValues ? [`Endpunkt ${quote(info.endpointHost)}`] : []),
    ];
    return `  ${alias.padEnd(valueColumn)}${parts.join(', ')}`;
  }),
];

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
        (
          [
            'host',
            'subject',
            'path',
            'keys',
            'policy',
            'routines',
            'providers',
            'tokens',
            'drafts',
            'notices',
            'metrics',
            'ping',
          ] as const
        ).filter((entry) => hidden.has(entry)),
      ),
    );
  }
  if (options.policy !== undefined) lines.push(...policyLines(options.policy));
  if (options.providers !== undefined) {
    lines.push(...providerLines(options.providers, options.showValues));
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
  if (options.withoutEnding !== true) {
    lines.push(options.valid ? validText : invalidText);
  }
  return Object.freeze(lines);
}
