/**
 * Writes the five files of the docs index under `packages/docs-index/data/`
 * in their canonical form (ADR 0066): JSON with two spaces of indent, the
 * fields in the order of the format and a line break at the end. Each file
 * of facts carries its format, a notice of its source and its terms
 * (ADR 0027) and its entries. `SOURCES.json` names each source that has
 * facts, without a host.
 *
 * The scripts load no package of the workspace (ADR 0020), so the order
 * of the fields stands here a second time. The tests hold both together:
 * they let the checks of the package read what this module writes.
 *
 * @packageDocumentation
 */
import { renameSync, rmSync, writeFileSync } from 'node:fs';

import { SpikeError } from '../../spike/lib/errors.mts';
import { isObject, type OpenApiDocument } from '../../spike/lib/spec.mts';
import type { AcademyPageEntry } from './academy.mts';
import { factDepth, type OperationFactEntry } from './operations.mts';
import type { RightFactEntry } from './rights.mts';
import { cleanLine } from './text.mts';

/** The names of the five files. */
export const factFileNames = Object.freeze({
  sources: 'SOURCES.json',
  operations: 'operations.json',
  rights: 'rights.json',
  academy: 'academy.json',
  operationRights: 'operation-rights.json',
} as const);

/** The text of each file, by its name. */
export type FactTexts = Readonly<
  Record<(typeof factFileNames)[keyof typeof factFileNames], string>
>;

/** Where the facts of the OpenAPI document came from. */
export interface OpenApiOrigin {
  readonly retrievedAt: string;
  readonly sha256: string;
  readonly documentVersion: string;
  readonly churchToolsVersion: string;
}

/** Where the facts about the rights came from. */
export interface PermissionsOrigin {
  readonly retrievedAt: string;
  readonly sha256: string;
  readonly churchToolsVersion: string;
}

/** Where the help pages came from. */
export interface AcademyOrigin {
  readonly retrievedAt: string;
  readonly pages: readonly { readonly path: string; readonly sha256: string }[];
}

/** Everything the four files hold. */
export interface RefreshedFacts {
  readonly operations: readonly OperationFactEntry[];
  readonly rights: readonly RightFactEntry[];
  readonly academy: readonly AcademyPageEntry[];
  readonly operationsNotice: string;
  readonly openapi: OpenApiOrigin;
  readonly permissions: PermissionsOrigin;
  readonly academyOrigin: AcademyOrigin;
}

const rightsNotice =
  'Fakten zu den Rechten von ChurchTools: Modul, Name und Art jedes Rechts aus der Antwort von GET /api/permissions/global, ohne die Werte einer Instanz. Bezeichnungen stammen aus Hilfeseiten der ChurchTools Academy, je mit dem Pfad ihrer Seite. Für sie gilt, was in academy.json steht.';

const academyNotice =
  'Texte frei zugänglicher Hilfeseiten der ChurchTools Academy, von Ecclium aufbereitet: ohne Bilder, Navigation und Skripte, Links nur als Pfad auf der Academy. © ChurchTools, alle Rechte vorbehalten. Ecclium gibt die Texte mit Erlaubnis des Herstellers wieder, mit Namensnennung und Link. Sie stehen unter keiner Lizenz des Projekts. Ecclium ist ein unabhängiges Projekt und steht in keiner Verbindung zum Hersteller von ChurchTools.';

// The mapping is work of the project, not taken from a source, and stands
// under the licence of the code, unlike the other files (ADR 0066).
const operationRightsNotice =
  'Zuordnung von Operationen der API von ChurchTools zu den Rechten, die sie verlangen, von Hand erstellt im Projekt Ecclium. Jede Paarung hat einen Beleg: einen Befund des Projekts in docs/research/churchtools-api.md mit der Version von ChurchTools, an der die Probe lief, die Beschreibung der Operation im OpenAPI-Dokument oder eine Hilfeseite der ChurchTools Academy. Sie nennt, was belegt ist, nie alle Bedingungen einer Operation. Eigene Arbeit des Projekts ohne Texte aus den Quellen, unter der Elastic License 2.0 wie der Quellcode.';

/** The licence the facts from the OpenAPI document stand under (ADR 0027). */
export const openApiLicence = 'CC BY 4.0';

function fail(where: string): never {
  throw new SpikeError('ANTWORT_UNGUELTIG', 'quelleUngueltig', where);
}

/**
 * The notice of `operations.json`, from `info` of the document: its
 * title, its version, the name of its contact and its licence, and that
 * Ecclium has changed it (ADR 0027). Address and link of the contact stay
 * out, since they name hosts. `info` brings no disclaimer of warranty
 * (D1), so the notice points to the one in the licence.
 *
 * @param document - The OpenAPI document.
 * @param churchToolsVersion - The version the instance reported.
 * @returns The notice.
 * @throws {SpikeError} If the document names another licence than
 *   CC BY 4.0, which needs a new decision (ADR 0027), or no title.
 */
export function openApiNotice(
  document: OpenApiDocument,
  churchToolsVersion: string,
): string {
  const info = isObject(document['info']) ? document['info'] : {};
  const licence = isObject(info['license'])
    ? info['license']['name']
    : undefined;
  if (licence !== openApiLicence) {
    return fail('openapi.info.license');
  }
  const title =
    typeof info['title'] === 'string'
      ? cleanLine(info['title'], 'en')
      : undefined;
  if (title === undefined || title.length > 200) {
    return fail('openapi.info.title');
  }
  const version = documentVersionOf(document);
  const contact =
    isObject(info['contact']) && typeof info['contact']['name'] === 'string'
      ? cleanLine(info['contact']['name'], 'en')
      : undefined;
  if (contact !== undefined && contact.length > 200) {
    return fail('openapi.info.contact');
  }
  return [
    `Fakten aus dem OpenAPI-Dokument «${title}» von ChurchTools, Version ${version} des Dokuments, abgerufen von einer Instanz mit ChurchTools ${churchToolsVersion}.`,
    ...(contact === undefined ? [] : [`Kontakt laut Dokument: ${contact}.`]),
    'Das Dokument steht unter der Lizenz CC BY 4.0, ihr Text liegt in LICENSES/CC-BY-4.0.txt.',
    `Ecclium hat es bearbeitet: ausgewählte Felder, Schemas nach ${String(factDepth)} Schritten gekürzt, ohne Beispiele, Vorgaben und Server, Links auf andere Hosts entfernt.`,
    'Diese Fakten sind bearbeitetes Material und stehen ebenfalls unter CC BY 4.0, nicht unter der Elastic License 2.0.',
    'Für sie gilt der Ausschluss der Gewährleistung und der Haftung in Abschnitt 5 der Lizenz.',
    'Ecclium ist ein unabhängiges Projekt und steht in keiner Verbindung zum Hersteller von ChurchTools.',
  ].join(' ');
}

/**
 * The version the document names in `info.version`, in the form
 * `SOURCES.json` takes.
 *
 * @param document - The OpenAPI document.
 * @returns The version, such as `0.1.0`.
 * @throws {SpikeError} If it has no version of that form.
 */
export function documentVersionOf(document: OpenApiDocument): string {
  const info = isObject(document['info']) ? document['info'] : {};
  const version = info['version'];
  return typeof version === 'string' &&
    /^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/.test(version)
    ? version
    : fail('openapi.info.version');
}

function canonical(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Writes the facts as the texts of the five files. A source without
 * entries stays out of `SOURCES.json`, as the checks demand.
 *
 * @param facts - The facts and their sources.
 * @returns The text of each file.
 */
export function factFileTexts(facts: RefreshedFacts): FactTexts {
  const sources: Record<string, unknown> = {
    format: 'ecclium.docs.sources.v1',
  };
  if (facts.operations.length > 0) {
    sources['openapi'] = {
      retrievedAt: facts.openapi.retrievedAt,
      sha256: facts.openapi.sha256,
      documentVersion: facts.openapi.documentVersion,
      churchToolsVersion: facts.openapi.churchToolsVersion,
    };
  }
  if (facts.rights.length > 0) {
    sources['permissions'] = {
      retrievedAt: facts.permissions.retrievedAt,
      sha256: facts.permissions.sha256,
      churchToolsVersion: facts.permissions.churchToolsVersion,
    };
  }
  if (facts.academy.length > 0) {
    sources['academy'] = {
      retrievedAt: facts.academyOrigin.retrievedAt,
      pages: facts.academyOrigin.pages.map(({ path, sha256 }) => ({
        path,
        sha256,
      })),
    };
  }
  return {
    'SOURCES.json': canonical(sources),
    'operations.json': canonical({
      format: 'ecclium.docs.operations.v1',
      notice: facts.operationsNotice,
      entries: facts.operations,
    }),
    'rights.json': canonical({
      format: 'ecclium.docs.rights.v1',
      notice: rightsNotice,
      entries: facts.rights.map(({ module, name, kind, pages }) => ({
        module,
        name,
        kind,
        pages,
      })),
    }),
    'academy.json': canonical({
      format: 'ecclium.docs.academy.v1',
      notice: academyNotice,
      entries: facts.academy,
    }),
    'operation-rights.json': canonical({
      format: 'ecclium.docs.operation-rights.v1',
      notice: operationRightsNotice,
      entries: [],
    }),
  };
}

/**
 * Writes the files into a folder: first each into a new file of its
 * own next to it, flushed to the disk, and only when all stand, each
 * in place of the old one. A failure while writing leaves the old files
 * as they were, so that no file holds new facts with the sources of old
 * ones, or the other way round.
 *
 * @param texts - The text of each file.
 * @param dataDir - The folder, ending in `/`.
 * @throws {Error} If a file cannot be written; the new files are removed then.
 */
export function writeFactFiles(texts: FactTexts, dataDir: URL): void {
  const pending = Object.entries(texts).map(([name, text]) => ({
    text,
    target: new URL(name, dataDir),
    temporary: new URL(`.${name}.refresh`, dataDir),
  }));
  try {
    for (const file of pending) {
      writeFileSync(file.temporary, file.text, { flag: 'wx', flush: true });
    }
  } catch (error) {
    for (const file of pending) {
      try {
        rmSync(file.temporary, { force: true });
      } catch {
        // Not a file of this run, such as a folder in its place: it stays.
      }
    }
    throw error;
  }
  for (const file of pending) {
    renameSync(file.temporary, file.target);
  }
}
