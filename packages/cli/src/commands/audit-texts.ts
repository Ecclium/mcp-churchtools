/**
 * The German texts of `ecclium audit verify` and `ecclium audit show`
 * (ADR 0028). They name files by their name, never by a path, and IDs of
 * objects only when the operator asks for one with `--object`. Every line
 * passes the rule of the output for a terminal.
 *
 * @packageDocumentation
 */
import {
  type ConfigProblem,
  objectDomains,
} from '@ecclium/mcp-churchtools-core';
import {
  type AuditAnchorSet,
  type AuditFindingKind,
  type AuditFolderCode,
  type AuditSummary,
  type AuditVerifyReport,
  maxAnchors,
  maxShownHits,
} from '@ecclium/mcp-churchtools-core/audit';

import { formatNumber, problemText } from '../messages/index.js';

/** What can be wrong with the values of `ecclium audit show`. */
export type AuditShowProblem = 'object' | 'day' | 'range';

/** One text per kind of wrong value: what, why and what to do. */
export const auditShowProblemTexts: Readonly<Record<AuditShowProblem, string>> =
  Object.freeze({
    object: `Die Kennung nach ‹--object› hat nicht die Form ‹Bereich:Kennung›, etwa ‹person:42›. Ecclium nennt sie nicht und kennt nur die Bereiche ${objectDomains.join(', ')}. Geben Sie den Bereich klein und die Kennung als Ziffern oder als GUID an.`,
    day: 'Ein Tag nach ‹--since› oder ‹--until› ist kein Tag, den es gibt. Ecclium nennt ihn nicht und nimmt nur die Form JJJJ-MM-TT in UTC. Geben Sie den Tag etwa als ‹2026-10-31› an.',
    range:
      'Der Tag nach ‹--since› liegt nach dem Tag nach ‹--until›. Dazwischen gibt es keinen Tag, der sich zusammenfassen liesse. Nennen Sie nach ‹--since› den früheren Tag.',
  });

/** One text per reason the folder `audit` cannot be read. */
export const auditFolderTexts: Readonly<Record<AuditFolderCode, string>> =
  Object.freeze({
    audit_read_platform:
      'Auf diesem System lassen sich die Audit-Dateien nicht sicher lesen. Es fehlt die Prüfung des Eigentümers oder das Öffnen ohne Links, etwa unter Windows, wo es über stdio auch keine Audit-Datei gibt. Lesen Sie die Dateien auf dem System, auf dem der Server läuft.',
    audit_folder_missing:
      'Im Zustandsordner gibt es keinen Ordner ‹audit›. Ecclium legt ihn beim ersten Start mit dem Zustandsordner an, vorher gibt es keine Audit-Dateien. Prüfen Sie, ob ‹ECCLIUM_STATE_DIR› derselbe Ordner ist wie in der Konfiguration des KI-Assistenten.',
    audit_folder_unsafe:
      'Der Ordner ‹audit› im Zustandsordner ist kein privater Ordner Ihres Benutzers, etwa ein Link oder ein Ordner mit Rechten für andere, oder er hat sich beim Lesen geändert. Ecclium liest ihn nicht, weil die Dateien darin dann nicht von Ecclium stammen müssen. Prüfen Sie Eigentümer und Rechte, der Ordner braucht die Rechte 700.',
    audit_folder_unavailable:
      'Der Ordner ‹audit› im Zustandsordner liess sich nicht lesen. Die Meldung des Dateisystems zeigt Ecclium nicht, weil sie den Pfad enthält. Prüfen Sie die Rechte des Ordners und versuchen Sie es erneut.',
  });

/** The text when a log of `--log` cannot be read. */
export const logUnreadableText =
  'Eine Datei aus ‹--log› liess sich nicht lesen oder ist ein Ordner. Ecclium nennt den Pfad nicht. Prüfen Sie die Angabe nach ‹--log›, ‹-› liest stdin.';

const findingTexts: Readonly<Record<AuditFindingKind, string>> = Object.freeze({
  line_form: 'Die Zeile hat nicht die Form, in der Ecclium Zeilen schreibt.',
  line_too_long: 'Die Zeile ist länger, als Ecclium eine Zeile schreibt.',
  chain_mixed: 'Nur ein Teil der Zeilen dieser Datei trägt eine Kette.',
  chain_name:
    'Die erste Zeile passt nicht zum Namen der Datei. Die Datei wurde umbenannt oder vertauscht, oder ihre ersten Zeilen fehlen.',
  chain_link:
    'Die Kette bricht vor dieser Zeile. Davor wurde eine Zeile geändert, entfernt, eingefügt oder verschoben.',
  chain_seq: 'Die Folgenummer passt nicht zur Zeile davor.',
  anchor_mismatch:
    'Die Zeile, die der Anker im Log nennt, ist nicht mehr dieselbe.',
  anchor_truncated:
    'Die Datei endet vor der Zeile, die der Anker im Log nennt. Sie wurde gekürzt.',
  anchor_extended:
    'Nach der Zeile, die der Anker im Log nennt, stehen weitere Zeilen.',
  anchor_conflict: 'Das Log nennt zwei verschiedene Anker für diese Datei.',
  file_missing:
    'Ein Anker im Log nennt diese Datei, sie fehlt aber im Ordner, und ihre Frist ist nicht abgelaufen.',
  file_unsafe:
    'Der Eintrag ist keine private Datei mit einem einzigen Link, etwa ein Link, ein Ordner oder eine Datei mit Rechten für andere. Ecclium hat ihn nicht gelesen.',
  file_unreadable: 'Die Datei liess sich nicht ganz lesen.',
  folder_moved:
    'Der Ordner ‹audit› hat sich während der Prüfung geändert. Die Prüfung endet hier.',
});

/**
 * The lines for problems of the configuration, as `ecclium config check`
 * writes them.
 *
 * @param problems - The problems the loader reported.
 * @param omitted - The problems beyond them.
 * @returns The lines, frozen.
 * @example
 * ```ts
 * for (const line of problemLines(loaded.problems, loaded.omittedProblems)) output.stderr(line);
 * ```
 */
export function problemLines(
  problems: readonly ConfigProblem[],
  omitted: number,
): readonly string[] {
  const total = problems.length + omitted;
  const lines = [
    total === 1
      ? 'Die Konfiguration hat 1 Problem:'
      : `Die Konfiguration hat ${formatNumber(total)} Probleme:`,
    ...problems.map((problem) => `  - ${problemText(problem)}`),
  ];
  if (omitted > 0) {
    lines.push(
      `  und ${formatNumber(omitted)} ${omitted === 1 ? 'weiteres' : 'weitere'}`,
    );
  }
  return Object.freeze(lines);
}

const count = (value: number, one: string, many: string): string =>
  `${formatNumber(value)} ${value === 1 ? one : many}`;

/**
 * Whether a report of `ecclium audit verify` has a finding about the data,
 * a file that could not be read aside.
 *
 * @param report - The report.
 * @returns Whether it has such a finding.
 */
export const hasDataFinding = (report: AuditVerifyReport): boolean =>
  report.findingsOmitted > 0 ||
  report.findings.some((finding) => finding.kind !== 'file_unreadable');

/**
 * The lines of `ecclium audit verify`: the counts, the findings and the
 * result.
 *
 * @param report - What the check found.
 * @param anchors - The anchors from the logs, if any were given.
 * @returns The lines, frozen.
 * @example
 * ```ts
 * for (const line of renderVerifyReport(report, anchors)) output.stdout(line);
 * ```
 */
export function renderVerifyReport(
  report: AuditVerifyReport,
  anchors: AuditAnchorSet | undefined,
): readonly string[] {
  const lines = [
    'Prüfung der Audit-Dateien',
    `  Dateien im Ordner ‹audit›: ${formatNumber(report.files)}, davon ganz geprüft ${formatNumber(report.checked)}`,
    `  Ganze Zeilen geprüft: ${formatNumber(report.lines)}`,
  ];
  if (report.unchained > 0) {
    lines.push(
      `  Dateien ohne Kette, aus einer Version von Ecclium vor der Kette: ${formatNumber(report.unchained)}`,
    );
  }
  if (report.others > 0) {
    lines.push(
      `  Andere Einträge im Ordner, nicht geprüft: ${formatNumber(report.others)}`,
    );
  }
  if (report.vanished > 0) {
    lines.push(
      `  Dateien, die während der Prüfung verschwanden: ${formatNumber(report.vanished)}`,
    );
  }
  if (anchors === undefined) {
    lines.push(
      'Ohne ‹--log› prüft Ecclium nur die Ketten. Eine gekürzte Datei oder eine geänderte letzte Zeile zeigt erst ein Anker aus dem Log.',
    );
  } else {
    lines.push(
      `  Dateien mit einem Anker aus dem Log: ${formatNumber(report.anchors)}, davon passend ${formatNumber(report.anchorsMatched)}, nach Ablauf der Frist gelöscht ${formatNumber(report.anchorsExpired)}`,
    );
    if (anchors.dropped > 0) {
      lines.push(
        `  Anker übergangen, weil das Log mehr als ${formatNumber(maxAnchors)} Dateien nennt: ${formatNumber(anchors.dropped)}`,
      );
    }
  }
  const total = report.findings.length + report.findingsOmitted;
  if (total > 0) {
    lines.push(`Befunde: ${formatNumber(total)}`);
    for (const finding of report.findings) {
      const where =
        finding.line === undefined
          ? finding.file
          : `${finding.file}, Zeile ${formatNumber(finding.line)}`;
      lines.push(`  - ${where}: ${findingTexts[finding.kind]}`);
    }
    if (report.findingsOmitted > 0) {
      lines.push(
        `  und ${count(report.findingsOmitted, 'weiterer', 'weitere')}`,
      );
    }
  }
  if (hasDataFinding(report)) {
    lines.push(
      'Ergebnis: Die Audit-Dateien stimmen nicht mit ihren Ketten oder Ankern überein. Bewahren Sie die Dateien und das Log unverändert auf und klären Sie, wer Zugriff auf den Zustandsordner hatte.',
    );
  } else if (total > 0) {
    lines.push(
      'Ergebnis: Nicht jede Datei liess sich lesen, sonst gibt es keinen Befund. Prüfen Sie die Rechte der Dateien und versuchen Sie es erneut.',
    );
  } else {
    // A log without an anchor for any file, such as the log of another
    // folder of state, checks nothing against anchors, which the result
    // must not hide.
    lines.push(
      anchors === undefined
        ? 'Ergebnis: Die Ketten der Audit-Dateien sind ganz.'
        : report.anchors === 0
          ? 'Ergebnis: Die Ketten der Audit-Dateien sind ganz. Das Log enthält aber keinen Anker zu einer dieser Dateien, gegen Anker ist nichts geprüft.'
          : 'Ergebnis: Die Ketten der Audit-Dateien sind ganz und passen zu den Ankern aus dem Log.',
    );
  }
  return Object.freeze(lines);
}

// 2026-10-31 as 31.10.2026.
const dateOf = (day: string): string =>
  `${day.slice(8, 10)}.${day.slice(5, 7)}.${day.slice(0, 4)}`;

/** The range of days of `ecclium audit show`. */
export interface ShowRange {
  readonly since?: string | undefined;
  readonly until?: string | undefined;
}

const rangeLine = (range: ShowRange): string | undefined => {
  if (range.since !== undefined && range.until !== undefined) {
    return `Zeitraum: vom ${dateOf(range.since)} bis und mit ${dateOf(range.until)}`;
  }
  if (range.since !== undefined) {
    return `Zeitraum: ab ${dateOf(range.since)}`;
  }
  if (range.until !== undefined) {
    return `Zeitraum: bis und mit ${dateOf(range.until)}`;
  }
  return undefined;
};

const outcomeWords = Object.freeze({
  ok: 'ausgeführt',
  error: 'mit Fehler',
  denied: 'abgelehnt',
});

const toolName = (tool: string | undefined): string => tool ?? 'ohne Tool';

const footer = (summary: AuditSummary): string[] => {
  const lines = [
    `Gelesen: ${formatNumber(summary.read)} von ${count(summary.files, 'Datei', 'Dateien')}, ${count(summary.lines, 'Zeile', 'Zeilen')} im Zeitraum.`,
  ];
  if (summary.skipped > 0) {
    lines.push(
      `${count(summary.skipped, 'Zeile passt', 'Zeilen passen')} nicht zum Schema der Ereignisse und ${summary.skipped === 1 ? 'fehlt' : 'fehlen'} in der Auswertung.`,
    );
  }
  if (summary.unread > 0) {
    lines.push(
      `${count(summary.unread, 'Datei liess', 'Dateien liessen')} sich nicht lesen und ${summary.unread === 1 ? 'fehlt' : 'fehlen'} in der Auswertung.`,
    );
  }
  if (summary.moved) {
    lines.push(
      'Der Ordner ‹audit› hat sich während des Lesens geändert. Die Auswertung ist unvollständig.',
    );
  }
  lines.push(
    'Die Auswertung prüft die Ketten nicht. Das tut ‹ecclium audit verify›.',
  );
  return lines;
};

/**
 * The lines of `ecclium audit show` without `--object`: per UTC day and
 * tool the calls by outcome.
 *
 * @param summary - The summary of the audit files.
 * @param range - The range of days asked for.
 * @returns The lines, frozen.
 * @example
 * ```ts
 * for (const line of renderSummary(summary, {})) output.stdout(line);
 * ```
 */
export function renderSummary(
  summary: AuditSummary,
  range: ShowRange,
): readonly string[] {
  const lines = ['Aufrufe je Tag und Tool, Tage in UTC'];
  const period = rangeLine(range);
  if (period !== undefined) lines.push(period);
  let day: string | undefined;
  for (const row of summary.rows) {
    if (row.day !== day) {
      day = row.day;
      lines.push(dateOf(row.day));
    }
    const parts = (['ok', 'error', 'denied'] as const)
      .filter((outcome) => row[outcome] > 0)
      .map(
        (outcome) => `${formatNumber(row[outcome])} ${outcomeWords[outcome]}`,
      );
    const withheld =
      row.withheld > 0
        ? `, davon ${formatNumber(row.withheld)} nach dem Lesen zurückgehalten`
        : '';
    lines.push(
      `  ${toolName(row.tool)}: ${count(row.calls, 'Aufruf', 'Aufrufe')}, ${parts.join(', ')}${withheld}`,
    );
  }
  if (summary.rows.length === 0) {
    lines.push(
      period === undefined
        ? 'Die Audit-Dateien nennen keinen Aufruf.'
        : 'Die Audit-Dateien nennen keinen Aufruf in diesem Zeitraum.',
    );
  }
  lines.push(...footer(summary));
  return Object.freeze(lines);
}

/**
 * The lines of `ecclium audit show --object`: each call that names the ID,
 * with time, tool, subject and outcome.
 *
 * @param summary - The summary of the audit files with the hits.
 * @param object - The ID asked for, in the form of the audit.
 * @param range - The range of days asked for.
 * @returns The lines, frozen.
 * @example
 * ```ts
 * for (const line of renderObjectHits(summary, 'person:42', {})) output.stdout(line);
 * ```
 */
export function renderObjectHits(
  summary: AuditSummary,
  object: string,
  range: ShowRange,
): readonly string[] {
  const lines = [`Aufrufe, die ‹${object}› nennen, Zeiten in UTC`];
  const period = rangeLine(range);
  if (period !== undefined) lines.push(period);
  for (const hit of summary.hits) {
    const withheld = hit.withheld ? ', nach dem Lesen zurückgehalten' : '';
    lines.push(
      `  ${dateOf(hit.ts.slice(0, 10))} ${hit.ts.slice(11, 19)}  ${toolName(hit.tool)}  Subjekt ${hit.actorId}  ${outcomeWords[hit.outcome]}${withheld}`,
    );
  }
  const total = summary.hits.length + summary.hitsOmitted;
  if (total === 0) {
    lines.push(`Keine Zeile nennt ‹${object}›.`);
  } else {
    lines.push(
      `${count(total, 'Zeile nennt', 'Zeilen nennen')} ‹${object}›.${summary.hitsOmitted > 0 ? ` Gezeigt sind die ersten ${formatNumber(maxShownHits)}.` : ''}`,
    );
  }
  if (summary.partial > 0) {
    lines.push(
      `In ${count(summary.partial, 'weiteren Zeile', 'weiteren Zeilen')} fehlen Kennungen über die ersten 100 hinaus. Die gesuchte kann darunter sein.`,
    );
  }
  lines.push(...footer(summary));
  return Object.freeze(lines);
}
