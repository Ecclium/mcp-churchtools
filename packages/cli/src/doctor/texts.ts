/**
 * The texts of `ecclium doctor` in German (ADR 0055). They name a target
 * by its role, routines and accounts by their IDs and aliases and a right
 * by module and name; the host of a target only with `--show-values`. No
 * path, no ID of ChurchTools and no name of a person, so that the output
 * fits into a public issue as it is.
 *
 * Each section gives its lines and how many of them are findings. A line
 * that starts with «Befund» is one; the others say what was found to be
 * as it should, or what was not checked.
 *
 * @packageDocumentation
 */
import type {
  DirectProbe,
  EgressTargetProbe,
} from '@ecclium/mcp-churchtools-core/http';
import type {
  ErrorCode,
  IsoDate,
  RightRef,
} from '@ecclium/mcp-churchtools-plugin-api';

import { formatNumber } from '../messages/index.js';
import type { AccountCheck } from './accounts.js';
import type { CheckedTarget, EgressCheck } from './egress.js';
import { outsideTarget } from './egress.js';

/** Lines of a section and how many of them are findings. */
export interface Section {
  readonly lines: readonly string[];
  readonly findings: number;
}

const quote = (text: string): string => `‹${text}›`;

/** The start of a line that is a finding. */
export const findingPrefix = 'Befund: ';

// A date of the policy, as people in Switzerland write it.
const dayText = (day: IsoDate): string => {
  const [year = '', month = '', date = ''] = day.split('-');
  return `${date}.${month}.${year}`;
};

/** The heading of the report. */
export const headingText =
  'Prüfung durch ‹ecclium doctor›, erste Fassung: Sie prüft den Runner, noch nicht den Server.';

/** The line for a valid configuration. */
export const configValidText =
  'Die Konfiguration des Runners ist gültig. Einzelheiten zeigt ‹ecclium config check --runner›.';

/** The line after the report of an invalid configuration. */
export const configInvalidText =
  'Mit dieser Konfiguration startet der Runner nicht, darum prüft ‹ecclium doctor› nichts weiter und fragt nichts an. Beheben Sie die Probleme und rufen Sie ‹ecclium doctor› erneut auf.';

/** The line before the warnings of the start. */
export const warningsHeadingText = 'Beim Start meldet der Runner:';

/** What this version never checks. */
export const notCheckedText =
  'Nicht geprüft in dieser Fassung: die Uhrzeit, der Ablauf der Tokens, das Alter des Images und die Rechte des Kontos des Servers. Sie kommen mit einer späteren Fassung von ‹ecclium doctor›.';

const plural = (count: number, one: string, many: string): string =>
  count === 1 ? `1 ${one}` : `${formatNumber(count)} ${many}`;

/**
 * The last line: how many findings count for the exit code, and whether
 * the findings of the policy above do not.
 *
 * @param findings - The findings on the outbound path, the providers, the
 *   routines and the accounts.
 * @param policyFindings - The findings of the policy.
 * @returns One text.
 * @example
 * ```ts
 * resultText(0, 1);
 * ```
 */
export function resultText(findings: number, policyFindings: number): string {
  const counted =
    findings === 0
      ? 'Ergebnis: kein Befund zu Weg, Anbietern, Routinen und Konten.'
      : `Ergebnis: ${plural(findings, 'Befund', 'Befunde')} zu Weg, Anbietern, Routinen und Konten.`;
  return policyFindings === 0
    ? counted
    : `${counted} Die Befunde zur Richtlinie zählen nicht für den Exit-Code, weil sie oft gewollt sind.`;
}

// The roles of a target, such as «ChurchTools und Anbieter ‹default›»,
// with its name and port only on request.
const targetLabel = (target: CheckedTarget, showValues: boolean): string => {
  const roles = target.target.roles.join(' und ');
  return showValues
    ? `${roles} (${quote(`${target.target.host}:${target.target.port}`)})`
    : roles;
};

const targetTexts = (
  label: string,
  probe: EgressTargetProbe | undefined,
): { readonly text: string; readonly finding: boolean } => {
  if (probe === undefined) {
    return { text: `${label}: nicht geprüft.`, finding: false };
  }
  if (probe.ok) {
    return {
      text: `${label}: Tunnel über den Proxy und TLS in Ordnung.`,
      finding: false,
    };
  }
  switch (probe.reason) {
    case 'refused':
      return {
        text:
          probe.status === 403
            ? `${findingPrefix}${label}: Der Proxy weist den Tunnel mit 403 ab. Das Ziel steht nicht in seiner Liste, oder die Liste ist unvollständig.`
            : `${findingPrefix}${label}: Der Proxy gibt keinen Tunnel, Status ${String(probe.status)}. Bei 502 oder 503 erreicht er das Ziel nicht, etwa weil sein Name nicht auflöst.`,
        finding: true,
      };
    case 'unreachable':
      return {
        text: `${findingPrefix}${label}: Der Proxy aus ‹ECCLIUM_EGRESS_PROXY› ist nicht erreichbar. Prüfen Sie, ob er läuft und ob Name und Port stimmen. Die übrigen Ziele prüft ‹ecclium doctor› darum nicht.`,
        finding: true,
      };
    case 'no_answer':
      return {
        text: `${findingPrefix}${label}: Der Proxy nimmt die Verbindung an, gibt aber in der Frist keine Antwort auf den Tunnel. Er erreicht das Ziel womöglich nicht, oder er antwortet selbst nicht.`,
        finding: true,
      };
    case 'tls':
      return {
        text: `${findingPrefix}${label}: Der Proxy gibt den Tunnel, aber TLS mit dem Ziel scheitert. Das Zertifikat ist nicht vertraut oder lautet auf einen anderen Namen, das Ziel spricht kein TLS, oder etwas auf dem Weg bricht TLS auf.`,
        finding: true,
      };
  }
};

const outsideName = quote(outsideTarget.host);

const outsideTexts = (
  probe: EgressTargetProbe | undefined,
): { readonly text: string; readonly finding: boolean } => {
  if (probe === undefined) {
    return {
      text: `Ein Ziel ausserhalb der Liste (${outsideName}): nicht geprüft.`,
      finding: false,
    };
  }
  if (probe.ok) {
    return {
      text: `${findingPrefix}Der Proxy gibt einen Tunnel zu ${outsideName}, einem Namen ausserhalb jeder Liste. Er lässt also Ziele durch, die die Konfiguration nicht nennt. Nehmen Sie die Vorlage für Squid unverändert, mit der Liste aus ‹ecclium init egress›.`,
      finding: true,
    };
  }
  if (probe.reason === 'refused' && probe.status === 403) {
    return {
      text: `Ein Ziel ausserhalb der Liste (${outsideName}) weist der Proxy mit 403 ab, wie es sein soll.`,
      finding: false,
    };
  }
  if (probe.reason === 'refused') {
    return {
      text: `${findingPrefix}Für ${outsideName}, einen Namen ausserhalb jeder Liste, antwortet der Proxy mit Status ${String(probe.status)} statt 403. Er hat den Namen also aufzulösen oder zu erreichen versucht, statt ihn an der Liste abzuweisen, und kann über DNS nach aussen sprechen. Nehmen Sie die Vorlage für Squid unverändert.`,
      finding: true,
    };
  }
  return {
    text: `${findingPrefix}Auf den Tunnel zu ${outsideName}, einem Namen ausserhalb jeder Liste, antwortet der Proxy nicht mit 403.`,
    finding: true,
  };
};

const directTexts = (
  direct: DirectProbe,
): { readonly text: string; readonly finding: boolean } => {
  if (direct.connected) {
    return {
      text: `${findingPrefix}Direkt, ohne den Proxy, steht eine Verbindung zu ChurchTools. Der Runner kommt so am Proxy vorbei nach aussen. Geben Sie ihm nur ein internes Netz, in dem der Proxy der einzige Weg nach aussen ist, und rufen Sie ‹ecclium doctor› dort auf, wo der Runner läuft.`,
      finding: true,
    };
  }
  switch (direct.reason) {
    case 'dns':
      return {
        text: 'Direkt, ohne den Proxy, löst der Name von ChurchTools nicht auf, und keine Verbindung kommt zustande. Ob eine Verbindung zu einer IP-Adresse durchkäme, zeigt das nicht.',
        finding: false,
      };
    case 'timeout':
      return {
        text: 'Direkt, ohne den Proxy, kommt in 10 Sekunden keine Verbindung zu ChurchTools zustande, so wenig wie für den Runner mit derselben Frist. Ob schon der Name nicht auflöste, zeigt das nicht.',
        finding: false,
      };
    case 'no_connection':
      return {
        text: 'Direkt, ohne den Proxy, kommt keine Verbindung zu ChurchTools zustande, wie es sein soll.',
        finding: false,
      };
  }
};

/**
 * The section of the outbound path.
 *
 * @param check - What the check found.
 * @param showValues - Whether to name host and port of each target.
 * @returns The lines and the number of findings.
 * @example
 * ```ts
 * egressSection(await checkEgress(config, egressProbes), false);
 * ```
 */
export function egressSection(
  check: EgressCheck,
  showValues: boolean,
): Section {
  const lines = ['Ausgehender Weg:'];
  if (check.kind === 'off') {
    lines.push(
      `  ${findingPrefix}Mit ‹ECCLIUM_EGRESS=off› geht der Runner ohne Grenze im Netz nach aussen, an jedes Ziel. ‹ecclium doctor› prüft den Weg dann nicht. Geben Sie dem Runner einen Proxy mit ‹ECCLIUM_EGRESS_PROXY› und der Vorlage für Squid.`,
    );
    return { lines, findings: 1 };
  }
  if (check.kind === 'ports') {
    const { roles } = check;
    lines.push(
      `  ${findingPrefix}${roles.join(', ')} ${roles.length === 1 ? 'hat' : 'haben'} einen anderen Port als 443 und ${roles.length === 1 ? 'steht' : 'stehen'} nicht in ‹ECCLIUM_EGRESS_ALLOW_LAN›. Die Vorlage für Squid liesse ${roles.length === 1 ? 'es' : 'sie'} nie durch, darum prüft ‹ecclium doctor› den Weg nicht. Liegt das Ziel im lokalen Netz, nehmen Sie Name und Port in ‹ECCLIUM_EGRESS_ALLOW_LAN› auf.`,
    );
    return { lines, findings: 1 };
  }
  let findings = 0;
  for (const target of check.targets) {
    const found = targetTexts(targetLabel(target, showValues), target.probe);
    lines.push(`  ${found.text}`);
    if (found.finding) findings += 1;
  }
  const probed = check.targets.flatMap(({ probe }) =>
    probe === undefined ? [] : [probe],
  );
  const refused = probed.filter(
    (probe) => !probe.ok && probe.reason === 'refused' && probe.status === 403,
  );
  if (refused.length > 0 && refused.length === probed.length) {
    lines.push(
      '  Weil der Proxy jedes Ziel mit 403 abweist, ist die Liste der Ziele wohl unvollständig, etwa ohne ihre letzte Zeile, oder sie stammt aus einer anderen Konfiguration. Erzeugen Sie sie mit ‹ecclium init egress› neu und ersetzen Sie die Datei; hängen Sie nie an eine Liste an.',
    );
  } else if (refused.length > 0) {
    lines.push(
      '  Die Ziele mit 403 fehlen in der Liste des Proxys, sie stammt wohl aus einer anderen Konfiguration. Erzeugen Sie sie mit ‹ecclium init egress› aus dieser Konfiguration neu und ersetzen Sie die Datei.',
    );
  }
  for (const found of [
    outsideTexts(check.outside),
    directTexts(check.direct),
  ]) {
    lines.push(`  ${found.text}`);
    if (found.finding) findings += 1;
  }
  lines.push(
    '  Nicht geprüft: die Sperre privater und besonderer Adressen im Proxy. Ein Name ausserhalb der Liste endet schon vorher mit 403, und die Sperre selbst bräuchte einen Namen der Liste, der auf eine private Adresse zeigt. Sie belegt nur ein Lauf der Vorlage für Squid mit Docker.',
  );
  return { lines, findings };
}

/**
 * The line of a provider: which routines that start use its model.
 *
 * @param alias - The alias of the provider.
 * @param routines - The IDs of the routines that start with its model.
 * @returns One text.
 * @example
 * ```ts
 * providerUseText('default', ['dienstplan-report']);
 * ```
 */
export function providerUseText(
  alias: string,
  routines: readonly string[],
): string {
  return routines.length === 0
    ? `${quote(alias)}: Keine Routine, die startet, nutzt ihn. Die Liste aus ‹ecclium init egress› nennt den Anbieter trotzdem.`
    : `${quote(alias)}: genutzt von ${routines.map(quote).join(', ')}.`;
}

/** The line without a file of the providers. */
export const noProvidersText =
  'Anbieter von Sprachmodellen: keine Datei der Anbieter, also auch keine Routine mit Modell.';

const rightsText = (rights: readonly RightRef[]): string =>
  rights
    .map(({ module, right }) => `${quote(module)} ${quote(right)}`)
    .join(', ');

// What a code of the pipeline says about the account, after the code.
const failureHints: Partial<Readonly<Record<ErrorCode, string>>> =
  Object.freeze({
    auth: ' ChurchTools nimmt das Token des Kontos nicht an. Erneuern Sie das Token in der Datei des Kontos.',
    upstream:
      ' Diesen Fehler gibt es auch, wenn das Konto mehr als 150 gesetzte Rechte hat. Ein Konto des Runners braucht nur die Rechte seiner Routinen.',
    network:
      ' Ecclium erreichte ChurchTools nicht, mit einem Proxy auch nicht durch ihn.',
  });

const accountLines = (account: AccountCheck): Section => {
  const name =
    account.credential === 'runner'
      ? `Konto ${quote('runner')}, das eigene Konto des Runners`
      : `Konto ${quote(account.credential)}`;
  const routines =
    account.routines.length === 0
      ? 'keine Routine, die startet'
      : `Routinen, die starten: ${account.routines.map(quote).join(', ')}`;
  const refused =
    account.refused.length === 0
      ? ''
      : `; nicht starten: ${account.refused.map(({ routineId }) => quote(routineId)).join(', ')}`;
  const lines = [`  ${name}: ${routines}${refused}.`];
  const { rights } = account;
  switch (rights.kind) {
    case 'account':
      lines.push(
        `    ${findingPrefix}Das Token des Kontos lässt sich nicht verwenden, Code ${quote(rights.code)}. Prüfen Sie die Datei ‹ct_token_<Alias>› im Ordner aus ‹ECCLIUM_RUNNER_TOKENS_DIR›: Sie muss vorhanden sein, Ihrem Benutzer gehören und die Rechte 600 haben.`,
      );
      return { lines, findings: 1 };
    case 'unknown':
      lines.push(
        `    ${findingPrefix}ChurchTools gab die Rechte in einer Form, die Ecclium nicht kennt. ‹ecclium doctor› prüft sie darum nicht.`,
      );
      return { lines, findings: 1 };
    case 'failed':
      lines.push(
        `    ${findingPrefix}Die Rechte liessen sich nicht lesen, Fehler ${quote(rights.code)}.${failureHints[rights.code] ?? ''}`,
      );
      return { lines, findings: 1 };
    case 'judged':
      break;
  }
  let findings = 0;
  const { beyond, missing, exceptions } = rights.rights;
  if (beyond.length === 0) {
    lines.push('    Rechte: keine, die seine Routinen nicht brauchen.');
  } else {
    findings += 1;
    lines.push(
      `    ${findingPrefix}Rechte, die seine Routinen nicht brauchen: ${rightsText(beyond)}.`,
    );
  }
  if (missing.length > 0) {
    findings += 1;
    lines.push(
      `    ${findingPrefix}Rechte, die seine Routinen brauchen und die ‹ct_whoami› nicht zeigt: ${rightsText(missing)}. Ein Schreibvorgang scheitert dann am Recht, und ein Lesen liefert womöglich weniger oder nichts. Rechte aus einer Gruppe zeigt ‹ct_whoami› womöglich nicht.`,
    );
  }
  if (rights.cut) {
    findings += 1;
    lines.push(
      `    ${findingPrefix}Das Konto darf in mehr als 10 Kategorien des Wikis schreiben. ‹ct_whoami› nennt nur die ersten 10, darum prüft ‹ecclium doctor› das Recht ‹edit category› nicht ganz.`,
    );
  }
  for (const { routine, until, holds } of exceptions) {
    const exception = `Die Ausnahme ‹acceptRightsDrift› der Routine ${quote(routine)}`;
    if (!holds) {
      lines.push(
        `    ${exception} gilt heute nicht, sie endet am ${dayText(until)} oder beginnt später.`,
      );
    } else if (beyond.length > 0 || rights.cut) {
      lines.push(
        `    ${exception} gilt bis ${dayText(until)}: Ihre Läufe schreiben trotz zu weiter Rechte.`,
      );
    } else {
      findings += 1;
      lines.push(
        `    ${findingPrefix}${exception} gilt bis ${dayText(until)}, obwohl die Rechte passen. Entfernen Sie sie, damit sie keine spätere Drift verdeckt.`,
      );
    }
  }
  return { lines, findings };
};

/**
 * The section of the accounts of the runner.
 *
 * @param accounts - What the check found for each account.
 * @returns The lines and the number of findings.
 * @example
 * ```ts
 * accountsSection(await checkAccounts(options));
 * ```
 */
export function accountsSection(accounts: readonly AccountCheck[]): Section {
  const lines = [
    'Konten des Runners, Rechte gelesen mit ‹ct_whoami› mit dem Token des Kontos und vermerkt im Audit:',
  ];
  let findings = 0;
  for (const account of accounts) {
    const section = accountLines(account);
    lines.push(...section.lines);
    findings += section.findings;
  }
  lines.push(
    '  Rechte zählen nur für Routinen, die starten. Was nur eine Routine braucht, die nicht startet, etwa ohne ihren Anbieter, gilt als zu weit. So bewertet auch der Write-Guard vor dem Schreiben eines Laufs: Die Schreibvorgänge des Kontos kämen in die Freigabe-Warteschlange, ausser eine Ausnahme ‹acceptRightsDrift› gilt.',
  );
  return { lines, findings };
}

/** The finding when the audit file of the reads cannot be used. */
export const accountsNoAuditText =
  'Konten des Runners: nicht geprüft, weil sich die Audit-Datei oder der Ordner der Zähler im Zustandsordner nicht verwenden lässt; den Grund nennt die Zeile auf stderr. Ohne Audit liest ‹ecclium doctor› nichts aus ChurchTools.';

/** The line when the routines do not load and no account is judged. */
export const accountsSkippedText =
  'Konten des Runners: nicht geprüft, weil die Routinen nicht laden.';

/**
 * The line that counts the routines.
 *
 * @param started - How many start.
 * @param refused - How many do not.
 * @returns One text.
 * @example
 * ```ts
 * routinesCountText(2, 1);
 * ```
 */
export function routinesCountText(started: number, refused: number): string {
  return `Routinen: ${plural(started, 'startet', 'starten')}, ${plural(refused, 'startet nicht', 'starten nicht')}.`;
}
