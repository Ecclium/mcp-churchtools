import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import ts from 'typescript';

// Reads every call of a logger in the code of the packages with the
// TypeScript checker (ADR 0054). A call counts when its method is debug,
// info, warn or error of the interface Logger of plugin-api, which every
// logger of the core has. The name of its event and its fields come from
// their types, not from the text: a constant, a field of a frozen object
// and a parameter typed with names of the catalog all resolve to the names
// they may hold. A name the checker knows only as a string is reported, so
// that no line can be written without an entry. A method of a logger that
// leaves its object, such as `const warn = log.warn`, is reported too,
// because its calls could not be read. Not seen are calls through a type
// that only looks like a Logger, a class that implements it, a cast away
// from it or a cast of the name; lint refuses casts to any, review the
// rest. The logger itself still refuses every name outside the catalog
// when the line is written, but not a field or level its entry does not
// name (ADR 0054).

/** The four methods of a logger, which are also its levels. */
const methods = new Set(['debug', 'info', 'warn', 'error']);

/** Where the interface Logger is declared, relative to the root. */
const loggerSource = ['packages', 'plugin-api', 'src', 'logger.ts'].join(sep);

/** One call of a logger. */
export interface LogCall {
  /** The file, relative to the root, with `/`. */
  readonly file: string;
  /** The line, counted from 1. */
  readonly line: number;
  /** The level, or undefined when the checker cannot name one. */
  readonly level: string | undefined;
  /** The names the event may have, or undefined when they are not fixed. */
  readonly events: readonly string[] | undefined;
  /** The fields the call may set, or undefined when they are not fixed. */
  readonly fields: readonly string[] | undefined;
}

/** A use of a logger method that is not a call. */
export interface LogEscape {
  readonly file: string;
  readonly line: number;
}

/** What the scan found. */
export interface LogScan {
  readonly calls: readonly LogCall[];
  readonly escapes: readonly LogEscape[];
  /**
   * Every string literal in the scanned code outside the catalog, for the
   * check of stale entries.
   */
  readonly literals: ReadonlySet<string>;
}

/** The code of the packages that ships: every .ts under src, no test. */
export function packageSources(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (
        entry.name.endsWith('.ts') &&
        !entry.name.endsWith('.test.ts') &&
        !entry.name.endsWith('.d.ts')
      ) {
        files.push(path);
      }
    }
  };
  for (const entry of readdirSync(join(root, 'packages'), {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory()) continue;
    const src = join(root, 'packages', entry.name, 'src');
    try {
      walk(src);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return files.sort();
}

// The options of tsconfig.base.json, so that imports of the workspace
// resolve to their source as in the type check, without output.
function compilerOptions(root: string): ts.CompilerOptions {
  const path = join(root, 'tsconfig.base.json');
  const read = ts.readConfigFile(path, (file) => readFileSync(file, 'utf8'));
  if (read.error !== undefined) throw new Error('tsconfig.base.json');
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, root);
  return {
    ...parsed.options,
    composite: false,
    declaration: false,
    declarationMap: false,
    sourceMap: false,
    noEmit: true,
    rootDir: undefined,
    outDir: undefined,
    tsBuildInfoFile: undefined,
    skipLibCheck: true,
  };
}

// The string literals a type stands for, or undefined if it stands for any
// other string too.
function literalsOf(type: ts.Type): string[] | undefined {
  const members = type.isUnion() ? type.types : [type];
  const values: string[] = [];
  for (const member of members) {
    if (!member.isStringLiteral()) return undefined;
    values.push(member.value);
  }
  return values.length === 0 ? undefined : values.sort();
}

/**
 * Scans the given files, which must lie under `root`, for calls of a
 * logger. `root` also holds tsconfig.base.json and the interface Logger at
 * packages/plugin-api/src/logger.ts. The literals of `catalogFile`, relative
 * to the root, do not count as a use of an entry.
 */
export function scanLogCalls(
  root: string,
  files: readonly string[],
  catalogFile: string,
): LogScan {
  const program = ts.createProgram([...files], compilerOptions(root));
  const checker = program.getTypeChecker();
  const scanned = new Set(files);
  const calls: LogCall[] = [];
  const escapes: LogEscape[] = [];
  const literals = new Set<string>();

  const isLoggerDeclaration = (declaration: ts.Node | undefined): boolean =>
    declaration !== undefined &&
    ts.isInterfaceDeclaration(declaration) &&
    declaration.name.text === 'Logger' &&
    relative(root, declaration.getSourceFile().fileName) === loggerSource;

  // Whether a type has the methods of the interface Logger, also through
  // an interface that extends it, Readonly or a union with undefined.
  const hasLoggerMethods = (type: ts.Type): boolean => {
    const target = checker.getNonNullableType(type);
    return [...methods].some((method) =>
      (checker.getPropertyOfType(target, method)?.declarations ?? []).some(
        (declaration) =>
          ts.isMethodSignature(declaration) &&
          isLoggerDeclaration(declaration.parent),
      ),
    );
  };

  // Whether a name stands for a method of the interface Logger.
  const isLoggerMethod = (name: ts.Node): boolean => {
    const declaration = checker.getSymbolAtLocation(name)?.declarations?.[0];
    return (
      declaration !== undefined &&
      ts.isMethodSignature(declaration) &&
      isLoggerDeclaration(declaration.parent)
    );
  };

  const fieldsOf = (
    argument: ts.Expression | undefined,
  ): string[] | undefined => {
    if (argument === undefined) return [];
    const type = checker.getTypeAtLocation(argument);
    const names = new Set<string>();
    for (const member of type.isUnion() ? type.types : [type]) {
      if (member.flags & ts.TypeFlags.Undefined) continue;
      // A record or any other index signature lets a call set any field.
      if (checker.getIndexInfosOfType(member).length > 0) return undefined;
      if (!(member.flags & ts.TypeFlags.Object)) return undefined;
      for (const property of checker.getPropertiesOfType(member)) {
        names.add(property.getName());
      }
    }
    return [...names].sort();
  };

  for (const source of program.getSourceFiles()) {
    if (!scanned.has(source.fileName)) continue;
    const file = relative(root, source.fileName).split(sep).join('/');
    const lineOf = (node: ts.Node): number =>
      source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteralLike(node) && file !== catalogFile) {
        literals.add(node.text);
      }
      if (
        ts.isPropertyAccessExpression(node) &&
        methods.has(node.name.text) &&
        isLoggerMethod(node.name)
      ) {
        const call = node.parent;
        if (ts.isCallExpression(call) && call.expression === node) {
          calls.push({
            file,
            line: lineOf(call),
            level: node.name.text,
            events:
              call.arguments[0] === undefined
                ? undefined
                : literalsOf(checker.getTypeAtLocation(call.arguments[0])),
            fields: fieldsOf(call.arguments[1]),
          });
        } else {
          escapes.push({ file, line: lineOf(node) });
        }
      } else if (
        ts.isElementAccessExpression(node) &&
        hasLoggerMethods(checker.getTypeAtLocation(node.expression))
      ) {
        const call = node.parent;
        const levels = literalsOf(
          checker.getTypeAtLocation(node.argumentExpression),
        );
        if (ts.isCallExpression(call) && call.expression === node) {
          calls.push({
            file,
            line: lineOf(call),
            // A level from a variable must be one fixed level.
            level: levels?.length === 1 ? levels[0] : undefined,
            events:
              call.arguments[0] === undefined
                ? undefined
                : literalsOf(checker.getTypeAtLocation(call.arguments[0])),
            fields: fieldsOf(call.arguments[1]),
          });
        } else {
          escapes.push({ file, line: lineOf(node) });
        }
      } else if (
        ts.isObjectBindingPattern(node) &&
        hasLoggerMethods(checker.getTypeAtLocation(node))
      ) {
        // const { warn } = log: the method leaves its object.
        escapes.push({ file, line: lineOf(node) });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { calls, escapes, literals };
}

/** The part of an entry of the catalog that the check reads. */
export interface CatalogEntry {
  readonly level: string;
  readonly fields: readonly string[];
}

/**
 * Compares a scan with a catalog and returns one sentence per finding,
 * sorted. Empty means every call has its entry and every entry its call.
 */
export function compareWithCatalog(
  scan: LogScan,
  catalog: Readonly<Record<string, CatalogEntry>>,
): string[] {
  const findings: string[] = [];
  const at = (call: { file: string; line: number }): string =>
    `${call.file}:${String(call.line)}`;
  for (const escape of scan.escapes) {
    findings.push(`${at(escape)} uses a method of a logger without calling it`);
  }
  for (const call of scan.calls) {
    if (call.level === undefined) {
      findings.push(`${at(call)} has no fixed level`);
    }
    if (call.events === undefined) {
      findings.push(`${at(call)} has no fixed event name`);
      continue;
    }
    for (const event of call.events) {
      const entry = Object.hasOwn(catalog, event) ? catalog[event] : undefined;
      if (entry === undefined) {
        findings.push(`${at(call)} writes ${event}, which has no entry`);
        continue;
      }
      if (call.level !== undefined && call.level !== entry.level) {
        findings.push(
          `${at(call)} writes ${event} at ${call.level}, the catalog says ${entry.level}`,
        );
      }
      if (call.fields === undefined) {
        findings.push(
          `${at(call)} writes ${event} with fields that are not fixed`,
        );
        continue;
      }
      for (const field of call.fields) {
        if (!entry.fields.includes(field)) {
          findings.push(
            `${at(call)} writes ${event} with ${field}, which its entry does not name`,
          );
        }
      }
    }
  }
  const written = new Set(scan.calls.flatMap((call) => call.events ?? []));
  for (const event of Object.keys(catalog)) {
    if (!written.has(event)) {
      findings.push(`${event} has an entry, but no call writes it`);
    } else if (!scan.literals.has(event)) {
      findings.push(`${event} has an entry, but no code names it`);
    }
  }
  return findings.sort();
}
