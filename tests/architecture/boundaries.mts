import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Loads and checks boundaries.json, the one description of the package
// boundaries. dependency-cruiser, ESLint and the architecture tests all read
// it through this module. A mistake in the file therefore stops every check
// with a message, instead of quietly emptying a single rule (ADR 0022).

/** Root folder of the workspace. */
export const workspaceRoot: string = fileURLToPath(
  new URL('../../', import.meta.url),
);

/** A workspace package and the packages its code may import at runtime. */
export interface PackageBoundary {
  /** Folder under `packages/`. */
  readonly dir: string;
  /** Package name from its `package.json`. */
  readonly name: string;
  /** Folders of the packages it may import. */
  readonly imports: readonly string[];
}

/** Keys of the places in the code that a rule refers to. */
export const placeKeys = [
  'rawClient',
  'rawClientImporters',
  'mcpMount',
  'mcpMountImporters',
  'mcpSdk',
  'stdioEntries',
  'stdout',
  'stderr',
  'plugins',
] as const;

/** Key of a place in the code that a rule refers to. */
export type PlaceKey = (typeof placeKeys)[number];

/** Paths of one place and the ADR that gives the reason for its rule. */
export interface Place {
  /** Number of the ADR, four digits. */
  readonly adr: string;
  readonly description: string;
  /** Paths from the workspace root. A folder ends in `/`. */
  readonly paths: readonly string[];
}

/** The checked content of boundaries.json. */
export interface Boundaries {
  readonly packages: readonly PackageBoundary[];
  /** The package that only tests may import. */
  readonly testOnly: string;
  readonly places: Readonly<Record<PlaceKey, Place>>;
}

// A list of exceptions may stay empty until the first module needs one. Every
// other place must name at least one path, or its rule would check nothing.
const mayBeEmpty: ReadonlySet<PlaceKey> = new Set(['rawClientImporters']);

type Report = (problem: string) => void;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isStringList = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

function checkKeys(
  object: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  required: readonly string[],
  where: string,
  report: Report,
): void {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) report(`${where}: unknown key "${key}"`);
  }
  for (const key of required) {
    if (!(key in object)) report(`${where}: missing key "${key}"`);
  }
}

function checkPath(
  path: string,
  where: string,
  dirs: ReadonlySet<string>,
  root: string,
  report: Report,
): void {
  const inside = /^packages\/([^/]+)\/src\//.exec(path);
  if (inside === null || !dirs.has(inside[1] ?? '')) {
    report(`${where}: "${path}" is not inside packages/<package>/src/`);
    return;
  }
  const parts = path.split('/').slice(0, path.endsWith('/') ? -1 : undefined);
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    report(`${where}: "${path}" is not a plain path`);
    return;
  }
  // Without the trailing slash, so that a file listed as a folder is reported
  // as such and not as missing.
  const stats = statSync(join(root, path.replace(/\/$/, '')), {
    throwIfNoEntry: false,
  });
  if (stats === undefined) {
    report(`${where}: "${path}" does not exist`);
  } else if (path.endsWith('/') && !stats.isDirectory()) {
    report(`${where}: "${path}" ends in / but is not a folder`);
  } else if (!path.endsWith('/') && stats.isDirectory()) {
    report(`${where}: "${path}" is a folder and must end in /`);
  }
}

function findCycle(
  packages: readonly PackageBoundary[],
): readonly string[] | undefined {
  const imports = new Map(packages.map((pkg) => [pkg.dir, pkg.imports]));
  const done = new Set<string>();
  const visit = (
    dir: string,
    path: readonly string[],
  ): readonly string[] | undefined => {
    if (path.includes(dir)) return [...path.slice(path.indexOf(dir)), dir];
    if (done.has(dir)) return undefined;
    for (const next of imports.get(dir) ?? []) {
      const cycle = visit(next, [...path, dir]);
      if (cycle !== undefined) return cycle;
    }
    done.add(dir);
    return undefined;
  };
  for (const pkg of packages) {
    const cycle = visit(pkg.dir, []);
    if (cycle !== undefined) return cycle;
  }
  return undefined;
}

function parsePackages(
  value: unknown,
  report: Report,
): readonly PackageBoundary[] {
  if (!Array.isArray(value)) {
    report('packages: must be a list');
    return [];
  }
  const packages: PackageBoundary[] = [];
  for (const [index, item] of value.entries()) {
    const where = `packages[${String(index)}]`;
    if (!isRecord(item)) {
      report(`${where}: must be an object`);
      continue;
    }
    const keys = ['dir', 'name', 'imports'];
    checkKeys(item, keys, keys, where, report);
    const { dir, name, imports } = item;
    if (typeof dir !== 'string' || !/^[a-z][a-z0-9-]*$/.test(dir)) {
      report(`${where}: dir must be the name of a folder under packages/`);
    } else if (typeof name !== 'string' || !name.startsWith('@ecclium/')) {
      report(`${where}: name must be a package name under @ecclium/`);
    } else if (!isStringList(imports)) {
      report(`${where}: imports must be a list of folders`);
    } else {
      packages.push({ dir, name, imports });
    }
  }
  return packages;
}

function checkImports(
  packages: readonly PackageBoundary[],
  testOnly: string,
  report: Report,
): void {
  const dirs = new Set(packages.map((pkg) => pkg.dir));
  if (dirs.size !== packages.length) {
    report('packages: a folder is listed twice');
  }
  if (new Set(packages.map((pkg) => pkg.name)).size !== packages.length) {
    report('packages: a name is listed twice');
  }
  for (const pkg of packages) {
    if (new Set(pkg.imports).size !== pkg.imports.length) {
      report(`${pkg.dir}: an import is listed twice`);
    }
    for (const target of pkg.imports) {
      if (target === pkg.dir) {
        report(`${pkg.dir}: lists itself as an import`);
      } else if (!dirs.has(target)) {
        report(`${pkg.dir}: imports the unknown package "${target}"`);
      } else if (target === testOnly) {
        report(`${pkg.dir}: ${target} is for tests only, not a runtime import`);
      }
    }
  }
  const cycle = findCycle(packages);
  if (cycle !== undefined) {
    report(`packages: the imports form a cycle: ${cycle.join(' -> ')}`);
  }
}

function parsePlaces(
  value: unknown,
  dirs: ReadonlySet<string>,
  root: string,
  report: Report,
): Partial<Record<PlaceKey, Place>> {
  const places: Partial<Record<PlaceKey, Place>> = {};
  if (!isRecord(value)) {
    report('places: must be an object');
    return places;
  }
  checkKeys(value, placeKeys, placeKeys, 'places', report);
  for (const key of placeKeys) {
    const item = value[key];
    const where = `places.${key}`;
    if (!isRecord(item)) {
      report(`${where}: must be an object`);
      continue;
    }
    const keys = ['adr', 'description', 'paths'];
    checkKeys(item, keys, keys, where, report);
    const { adr, description, paths } = item;
    if (typeof adr !== 'string' || !/^\d{4}$/.test(adr)) {
      report(`${where}: adr must be the four-digit number of an ADR`);
    } else if (typeof description !== 'string' || description.trim() === '') {
      report(`${where}: description must not be empty`);
    } else if (!isStringList(paths)) {
      report(`${where}: paths must be a list`);
    } else {
      if (paths.length === 0 && !mayBeEmpty.has(key)) {
        report(`${where}: names no path, so its rule would check nothing`);
      }
      if (new Set(paths).size !== paths.length) {
        report(`${where}: a path is listed twice`);
      }
      for (const path of paths) checkPath(path, where, dirs, root, report);
      places[key] = { adr, description, paths };
    }
  }
  return places;
}

/**
 * Checks a parsed boundaries.json and returns it typed.
 *
 * @param value - Parsed content of the file.
 * @param root - Workspace root, against which every path must exist.
 * @returns The checked boundaries.
 * @throws {Error} Naming every problem found, when the content is not valid.
 */
export function parseBoundaries(value: unknown, root: string): Boundaries {
  const problems: string[] = [];
  const report: Report = (problem) => {
    problems.push(problem);
  };
  if (!isRecord(value)) {
    throw new Error('boundaries.json: the top level must be an object');
  }
  checkKeys(
    value,
    ['$comment', 'packages', 'testOnly', 'places'],
    ['packages', 'testOnly', 'places'],
    'top level',
    report,
  );
  const packages = parsePackages(value['packages'], report);
  const dirs = new Set(packages.map((pkg) => pkg.dir));
  const testOnly = value['testOnly'];
  if (typeof testOnly !== 'string' || !dirs.has(testOnly)) {
    report('testOnly: must name a listed package');
  }
  checkImports(packages, typeof testOnly === 'string' ? testOnly : '', report);
  const places = parsePlaces(value['places'], dirs, root, report);

  if (problems.length > 0 || typeof testOnly !== 'string') {
    throw new Error(`boundaries.json: ${problems.join('; ')}`);
  }
  const complete = Object.fromEntries(
    placeKeys.map((key) => {
      const place = places[key];
      if (place === undefined) {
        throw new Error(`boundaries.json: places.${key} is missing`);
      }
      return [key, place];
    }),
  ) as Record<PlaceKey, Place>;
  return { packages, testOnly, places: complete };
}

/**
 * Reads and checks boundaries.json of a workspace.
 *
 * @param root - Workspace root, by default this workspace.
 * @returns The checked boundaries.
 * @throws {Error} When the file is missing, is not JSON or is not valid.
 */
export function loadBoundaries(root: string = workspaceRoot): Boundaries {
  const file = join(root, 'tests/architecture/boundaries.json');
  return parseBoundaries(JSON.parse(readFileSync(file, 'utf8')), root);
}
