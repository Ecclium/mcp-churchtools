/**
 * The loader of the routines (ADR 0033).
 *
 * Where it stands in a run: first of all, when the runner starts and
 * before anything is due. It reads every routine in the folder of the
 * routines with its prompt and its template, checks each, and hands the
 * runner the routines it may run. A run later never reads a file of its
 * routine again, so what a run does is what the loader checked.
 *
 * The folder holds one file `<ID>.yaml` per routine, its ID as the name,
 * and next to them the prompts and templates, in the folder itself or in
 * one folder below, such as `prompts/` and `templates/`. Other entries,
 * such as a README, it leaves alone. A file `.yml`, or `.yaml` with a
 * name that is no ID, it refuses instead of passing it over, so that no
 * routine goes missing without a word.
 *
 * Why it is strict: the routines decide what a run reads, what goes to a
 * model and where it writes. Folder, files and the folders of prompts and
 * templates get the checks of the files of the configuration: no link,
 * owned by the user, not writable for group and others, a limit of
 * bytes, UTF-8. A prompt or a template is named by a path inside the
 * folder only, so a routine cannot read a file elsewhere.
 *
 * The loader stops at the first problem, in the order of the names of
 * the files, and names the code, the routine and the field or line,
 * never a path of the file system or a value of a file.
 *
 * @packageDocumentation
 */
import {
  type ConfigDirectorySystem,
  type ConfigFileReason,
  type ConfigFileSystem,
  listConfigDirectory,
  readConfigTextFile,
  readConfigYaml,
} from '@ecclium/mcp-churchtools-core';
import { join } from 'node:path';

import { checkRoutine, type RoutineCheckCode, routineBlocks } from './check.js';
import type { Routine } from './schema.js';
import { parseTemplate, type Template, type TemplateCode } from './template.js';

/** The limits of the loader, frozen. */
export const routineFileLimits = Object.freeze({
  /** The most routines in the folder. */
  routines: 50,
  /** The most bytes of the file of a routine: 64 KiB. */
  routineBytes: 65_536,
  /** The most bytes of a prompt: 32 KiB. */
  promptBytes: 32_768,
  /** The most bytes of a template: 32 KiB. */
  templateBytes: 32_768,
} as const);

/** Why the routines of a folder are refused, frozen. */
export const routineLoadCodes = Object.freeze([
  'routines_dir',
  'routines_too_many',
  'routine_file_name',
  'routine_file',
  'routine_yaml_syntax',
  'routine_yaml_unsupported',
  'routine_id_mismatch',
  'routine_prompt',
  'routine_prompt_characters',
  'routine_template',
] as const);

/** Why the routines of a folder are refused. */
export type RoutineLoadCode =
  (typeof routineLoadCodes)[number] | RoutineCheckCode | TemplateCode;

/** A routine with what the loader read for it, deeply frozen. */
export interface LoadedRoutine {
  readonly routine: Routine;
  /** The text of the prompt, for a routine with a model. */
  readonly prompt?: string;
  /** The parsed template. */
  readonly template: Template;
}

/** The first problem of the routines of a folder. */
export interface RoutineLoadProblem {
  readonly code: RoutineLoadCode;
  /** The ID of the routine, once its file has a name that is one. */
  readonly routine?: string;
  /** Why a file or folder is refused, for the codes that read one. */
  readonly reason?: ConfigFileReason;
  /** The path of a field, such as `generate.prompt`. */
  readonly field?: string;
  /** The line of a problem of YAML or of the template, from 1. */
  readonly line?: number;
}

/** The routines of a folder, sorted by ID, or the first problem. */
export type RoutineLoadResult =
  | { readonly ok: true; readonly routines: readonly LoadedRoutine[] }
  | ({ readonly ok: false } & RoutineLoadProblem);

/** The file functions the loader uses; a test passes its own. */
export type RoutineFileSystem = ConfigFileSystem & ConfigDirectorySystem;

// The ID of a routine, as its schema takes it.
const idPattern = /^[a-z0-9][a-z0-9-]{0,62}$/;
// A control character other than tab, line feed and carriage return.
const promptControl = /[^\P{Cc}\t\n\r]/u;

const refuse = (problem: RoutineLoadProblem): RoutineLoadResult =>
  Object.freeze({ __proto__: null, ok: false, ...problem });

// Reads a prompt or a template the routine names by a path in the folder,
// after the checks of the folder below it, if any.
const readReferenced = (
  dir: string,
  path: string,
  maxBytes: number,
  fs: RoutineFileSystem | undefined,
): { readonly text: string } | { readonly reason: ConfigFileReason } => {
  const slash = path.indexOf('/');
  if (slash !== -1) {
    const folder = listConfigDirectory(join(dir, path.slice(0, slash)), fs);
    if (!folder.ok) return { reason: folder.reason };
  }
  const read = readConfigTextFile(join(dir, path), maxBytes, fs);
  return read.ok ? { text: read.text } : { reason: read.reason };
};

// Loads one routine from its file, with prompt and template.
const loadOne = (
  dir: string,
  id: string,
  fs: RoutineFileSystem | undefined,
): LoadedRoutine | RoutineLoadProblem => {
  const read = readConfigTextFile(
    join(dir, `${id}.yaml`),
    routineFileLimits.routineBytes,
    fs,
  );
  if (!read.ok)
    return { code: 'routine_file', routine: id, reason: read.reason };
  const yaml = readConfigYaml(read.text);
  if (!yaml.ok) {
    return {
      code: `routine_${yaml.code}` as const,
      routine: id,
      ...(yaml.line === undefined ? {} : { line: yaml.line }),
    };
  }
  const checked = checkRoutine(yaml.value);
  if (!checked.ok) {
    return {
      code: checked.code,
      routine: id,
      ...(checked.field === undefined ? {} : { field: checked.field }),
    };
  }
  const { routine } = checked;
  // The name of the file is the ID, so that one ID cannot stand in two
  // files and an operator finds a routine by its name.
  if (routine.id !== id) {
    return { code: 'routine_id_mismatch', routine: id, field: 'id' };
  }

  let prompt: string | undefined;
  if (routine.generate !== undefined) {
    const field = 'generate.prompt';
    const text = readReferenced(
      dir,
      routine.generate.prompt,
      routineFileLimits.promptBytes,
      fs,
    );
    if ('reason' in text) {
      return {
        code: 'routine_prompt',
        routine: id,
        reason: text.reason,
        field,
      };
    }
    if (promptControl.test(text.text)) {
      return { code: 'routine_prompt_characters', routine: id, field };
    }
    prompt = text.text;
  }

  const text = readReferenced(
    dir,
    routine.template,
    routineFileLimits.templateBytes,
    fs,
  );
  if ('reason' in text) {
    return {
      code: 'routine_template',
      routine: id,
      reason: text.reason,
      field: 'template',
    };
  }
  const parsed = parseTemplate(text.text, routineBlocks(routine));
  if (!parsed.ok) {
    return {
      code: parsed.code,
      routine: id,
      field: 'template',
      ...(parsed.line === undefined ? {} : { line: parsed.line }),
    };
  }
  return Object.freeze({
    routine,
    ...(prompt === undefined ? {} : { prompt }),
    template: parsed.template,
  });
};

/**
 * Loads the routines of a folder with their prompts and templates.
 *
 * @param dir - The absolute path of the folder of the routines.
 * @param fs - The file functions, only for tests.
 * @returns The checked routines, sorted by ID and deeply frozen, or the
 *   first problem. An empty folder gives no routines. It never throws
 *   for a folder or a file.
 * @throws {TypeError} When the path is not a string.
 * @example
 * ```ts
 * const loaded = loadRoutines('/path/to/routines');
 * if (!loaded.ok) report(loaded.code, loaded.routine, loaded.field);
 * ```
 */
export function loadRoutines(
  dir: string,
  fs?: RoutineFileSystem,
): RoutineLoadResult {
  if (typeof dir !== 'string') {
    throw new TypeError('The path of the folder must be a string.');
  }
  const listed = listConfigDirectory(dir, fs);
  if (!listed.ok)
    return refuse({ code: 'routines_dir', reason: listed.reason });

  const ids: string[] = [];
  for (const name of listed.names) {
    // In any case, because a folder on a system that ignores case would
    // otherwise pass over `Dienstplan.YAML` without a word.
    const lower = name.toLowerCase();
    if (!lower.endsWith('.yaml') && !lower.endsWith('.yml')) continue;
    const id = name.slice(0, -'.yaml'.length);
    if (!name.endsWith('.yaml') || !idPattern.test(id)) {
      return refuse({ code: 'routine_file_name' });
    }
    ids.push(id);
  }
  // By ID, not by the name of the file: `a-b.yaml` comes before
  // `a.yaml`, but `a` before `a-b`.
  ids.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (ids.length > routineFileLimits.routines) {
    return refuse({ code: 'routines_too_many' });
  }

  const routines: LoadedRoutine[] = [];
  for (const id of ids) {
    const loaded = loadOne(dir, id, fs);
    if ('code' in loaded) return refuse(loaded);
    routines.push(loaded);
  }
  return Object.freeze({
    __proto__: null,
    ok: true,
    routines: Object.freeze(routines),
  });
}
