import { describe, expect, it } from 'vitest';

import {
  loadRoutines,
  type RoutineFileSystem,
  routineFileLimits,
  routineLoadCodes,
} from './loader.js';

// A tree of folders, files and links in memory, by absolute path. Real
// files on disk come in the test of the fixtures under tests/routines/;
// here the cases need what a disk would not show, such as a file of
// another user.
interface Entry {
  readonly kind: 'dir' | 'file' | 'link';
  readonly text?: string;
  readonly mode?: number;
  readonly uid?: number;
}

const flags = {
  O_RDONLY: 0,
  O_NOFOLLOW: 1,
  O_NONBLOCK: 2,
  O_NOCTTY: 4,
  O_DIRECTORY: 8,
};

const fsError = (code: string): Error =>
  Object.assign(new Error(`${code}: /secret/path`), { code });

const memoryTree = (
  entries: Readonly<Record<string, Entry>>,
): RoutineFileSystem & { readonly opened: string[] } => {
  const opened: string[] = [];
  const open = new Map<number, { path: string; position: number }>();
  const entry = (path: string): Entry => {
    const found = entries[path];
    if (found === undefined) throw fsError('ENOENT');
    return found;
  };
  return {
    opened,
    openSync: (path, flag) => {
      const found = entry(path);
      if (found.kind === 'link') {
        // As on macOS: a link under O_DIRECTORY is no folder.
        throw fsError((flag & flags.O_DIRECTORY) === 0 ? 'ELOOP' : 'ENOTDIR');
      }
      if ((flag & flags.O_DIRECTORY) !== 0 && found.kind !== 'dir') {
        throw fsError('ENOTDIR');
      }
      opened.push(path);
      const fd = open.size + 10;
      open.set(fd, { path, position: 0 });
      return fd;
    },
    fstatSync: (fd) => {
      const found = entry(open.get(fd)?.path ?? '');
      const dir = found.kind === 'dir';
      return {
        isFile: () => found.kind === 'file',
        isDirectory: () => dir,
        uid: found.uid ?? 1000,
        mode:
          (dir ? 0o40000 : 0o100000) | (found.mode ?? (dir ? 0o755 : 0o644)),
        size: Buffer.byteLength(found.text ?? ''),
      };
    },
    readSync: (fd, buffer, offset, length) => {
      const state = open.get(fd);
      const bytes = Buffer.from(entry(state?.path ?? '').text ?? '');
      const chunk = bytes.subarray(
        state?.position ?? 0,
        (state?.position ?? 0) + length,
      );
      buffer.set(chunk, offset);
      if (state !== undefined) state.position += chunk.length;
      return chunk.length;
    },
    closeSync: () => undefined,
    readdirSync: (path) =>
      Object.keys(entries)
        .filter((key) => key.startsWith(`${path}/`))
        .map((key) => key.slice(path.length + 1))
        .filter((name) => !name.includes('/')),
    lstatSync: (path) => ({
      isSymbolicLink: () => entry(path).kind === 'link',
    }),
    getuid: () => 1000,
    constants: flags,
  };
};

const report = [
  'schema: routine.v1',
  'id: dienstplan-report',
  'schedule: "0 6 * * MON"',
  'inputs:',
  '  - name: termine',
  '    tool: ct_events_list',
  '    params: { from: "+0d", to: "+14d" }',
  '    maxItems: 30',
  'generate:',
  '  prompt: prompts/dienstplan-report.md',
  '  model: default',
  '  output:',
  '    blocks:',
  '      hinweise:',
  '        maxItems: 5',
  '        fields:',
  '          text: { type: text, maxLength: 400 }',
  'template: templates/dienstplan-report.md',
  'output:',
  '  target: wiki',
  '  tool: ct_wiki_page_append_section',
  '  scope: { category: Berichte, page: Dienstplan-Auswertung }',
  '  idempotencyKey: "dienstplan-report:{isoWeek}"',
  '',
].join('\n');

const hygiene = [
  'schema: routine.v1',
  'id: wiki-hygiene',
  'schedule: "0 7 1 * *"',
  'checks:',
  '  - check: brokenLinks',
  '    maxItems: 50',
  'template: wiki-hygiene.md',
  'output:',
  '  target: draft',
  '  channel: file',
  '  idempotencyKey: "wiki-hygiene:{month}"',
  '',
].join('\n');

const reportTemplate =
  '### Dienstplan {{period}}\n{{#hinweise}}\n- {{text}}\n{{/hinweise}}\n';
const hygieneTemplate =
  '{{#brokenLinks}}\n- {{page}}: {{link}}\n{{/brokenLinks}}\n';

// A folder of routines with the two routines above, their prompt and
// their templates, and a README the loader leaves alone.
const folder = (
  change: Readonly<Record<string, Entry | undefined>> = {},
): Record<string, Entry> => {
  const base: Record<string, Entry | undefined> = {
    '/r': { kind: 'dir' },
    '/r/README.md': { kind: 'file', text: '# Routinen\n' },
    '/r/dienstplan-report.yaml': { kind: 'file', text: report },
    '/r/wiki-hygiene.yaml': { kind: 'file', text: hygiene },
    '/r/prompts': { kind: 'dir' },
    '/r/prompts/dienstplan-report.md': {
      kind: 'file',
      text: 'Fasse den Dienstplan zusammen.\r\n',
    },
    '/r/templates': { kind: 'dir' },
    '/r/templates/dienstplan-report.md': { kind: 'file', text: reportTemplate },
    '/r/wiki-hygiene.md': { kind: 'file', text: hygieneTemplate },
    ...change,
  };
  return Object.fromEntries(
    Object.entries(base).filter(
      (pair): pair is [string, Entry] => pair[1] !== undefined,
    ),
  );
};

describe('loadRoutines with a valid folder', () => {
  it('loads every routine with its prompt and template, sorted and frozen', () => {
    const fs = memoryTree(folder());
    const result = loadRoutines('/r', fs);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.routines.map((loaded) => loaded.routine.id)).toEqual([
      'dienstplan-report',
      'wiki-hygiene',
    ]);
    const [withModel, withChecks] = result.routines;
    expect(withModel?.prompt).toBe('Fasse den Dienstplan zusammen.\r\n');
    expect(withModel?.template.parts[1]).toEqual({ kind: 'period' });
    expect(withChecks).not.toHaveProperty('prompt');
    expect(withChecks?.routine.output).toMatchObject({ target: 'draft' });
    const frozen = (value: unknown): boolean =>
      typeof value !== 'object' ||
      value === null ||
      (Object.isFrozen(value) && Object.values(value).every(frozen));
    expect(frozen(result)).toBe(true);
    expect(fs.opened).not.toContain('/r/README.md');
  });

  it('passes over a backup of a routine', () => {
    const result = loadRoutines(
      '/r',
      memoryTree(
        folder({ '/r/wiki-hygiene.yaml.bak': { kind: 'file', text: '' } }),
      ),
    );
    expect(result.ok && result.routines.length).toBe(2);
  });

  it('gives no routines for a folder without any', () => {
    expect(loadRoutines('/r', memoryTree({ '/r': { kind: 'dir' } }))).toEqual({
      ok: true,
      routines: [],
    });
  });

  it('sorts by ID, not by the name of the file', () => {
    const second = report
      .replaceAll('dienstplan-report', 'dienstplan')
      .replace('prompts/dienstplan.md', 'prompts/dienstplan-report.md')
      .replace('templates/dienstplan.md', 'templates/dienstplan-report.md');
    const result = loadRoutines(
      '/r',
      memoryTree(
        folder({ '/r/dienstplan.yaml': { kind: 'file', text: second } }),
      ),
    );
    expect(
      result.ok && result.routines.map((loaded) => loaded.routine.id),
    ).toEqual(['dienstplan', 'dienstplan-report', 'wiki-hygiene']);
  });
});

describe('loadRoutines with a folder it refuses', () => {
  it.each<[string, Record<string, Entry | undefined>, Record<string, unknown>]>(
    [
      [
        'a missing folder',
        { '/r': undefined },
        { code: 'routines_dir', reason: 'missing' },
      ],
      [
        'a folder others may write',
        { '/r': { kind: 'dir', mode: 0o777 } },
        { code: 'routines_dir', reason: 'mode' },
      ],
      [
        'a folder that is a link',
        { '/r': { kind: 'link' } },
        { code: 'routines_dir', reason: 'symlink' },
      ],
      [
        'a file with the ending .yml',
        { '/r/termin-vorschau.yml': { kind: 'file', text: '' } },
        { code: 'routine_file_name' },
      ],
      [
        'a file with the ending in upper case',
        { '/r/termin-vorschau.YAML': { kind: 'file', text: '' } },
        { code: 'routine_file_name' },
      ],
      [
        'a file whose name is no ID',
        { '/r/Termin Vorschau.yaml': { kind: 'file', text: '' } },
        { code: 'routine_file_name' },
      ],
      [
        'a routine of another user',
        { '/r/wiki-hygiene.yaml': { kind: 'file', text: hygiene, uid: 0 } },
        { code: 'routine_file', routine: 'wiki-hygiene', reason: 'owner' },
      ],
      [
        'a routine that is a link',
        { '/r/wiki-hygiene.yaml': { kind: 'link' } },
        { code: 'routine_file', routine: 'wiki-hygiene', reason: 'symlink' },
      ],
      [
        'a routine that is a folder',
        { '/r/wiki-hygiene.yaml': { kind: 'dir' } },
        {
          code: 'routine_file',
          routine: 'wiki-hygiene',
          reason: 'not_regular',
        },
      ],
      [
        'a routine that is too large',
        {
          '/r/wiki-hygiene.yaml': {
            kind: 'file',
            text: `${hygiene}#${'x'.repeat(routineFileLimits.routineBytes)}\n`,
          },
        },
        { code: 'routine_file', routine: 'wiki-hygiene', reason: 'too_large' },
      ],
      [
        'a routine with two documents of YAML',
        {
          '/r/wiki-hygiene.yaml': {
            kind: 'file',
            text: `${hygiene}---\nid: x\n`,
          },
        },
        { code: 'routine_yaml_syntax', routine: 'wiki-hygiene', line: 12 },
      ],
      [
        'a routine with an anchor',
        {
          '/r/wiki-hygiene.yaml': {
            kind: 'file',
            text: hygiene.replace('id: wiki-hygiene', 'id: &a wiki-hygiene'),
          },
        },
        { code: 'routine_yaml_unsupported', routine: 'wiki-hygiene', line: 2 },
      ],
      [
        'a routine of another version',
        {
          '/r/wiki-hygiene.yaml': {
            kind: 'file',
            text: hygiene.replace('routine.v1', 'routine.v2'),
          },
        },
        {
          code: 'routine_version_unknown',
          routine: 'wiki-hygiene',
          field: 'schema',
        },
      ],
      [
        'a routine whose ID is not its name',
        {
          '/r/wiki-hygiene.yaml': {
            kind: 'file',
            text: hygiene
              .replace('id: wiki-hygiene', 'id: wiki')
              .replace('wiki-hygiene:{month}', 'wiki:{month}'),
          },
        },
        { code: 'routine_id_mismatch', routine: 'wiki-hygiene', field: 'id' },
      ],
      [
        'a missing prompt',
        { '/r/prompts/dienstplan-report.md': undefined },
        {
          code: 'routine_prompt',
          routine: 'dienstplan-report',
          reason: 'missing',
          field: 'generate.prompt',
        },
      ],
      [
        'a prompt that is a link',
        { '/r/prompts/dienstplan-report.md': { kind: 'link' } },
        {
          code: 'routine_prompt',
          routine: 'dienstplan-report',
          reason: 'symlink',
          field: 'generate.prompt',
        },
      ],
      [
        'a folder of prompts that is a link',
        { '/r/prompts': { kind: 'link' } },
        {
          code: 'routine_prompt',
          routine: 'dienstplan-report',
          reason: 'symlink',
          field: 'generate.prompt',
        },
      ],
      [
        'a folder of prompts the group may write',
        { '/r/prompts': { kind: 'dir', mode: 0o775 } },
        {
          code: 'routine_prompt',
          routine: 'dienstplan-report',
          reason: 'mode',
          field: 'generate.prompt',
        },
      ],
      [
        'a prompt with a control character',
        {
          '/r/prompts/dienstplan-report.md': {
            kind: 'file',
            text: 'Fasse\u0000zusammen',
          },
        },
        {
          code: 'routine_prompt_characters',
          routine: 'dienstplan-report',
          field: 'generate.prompt',
        },
      ],
      [
        'a prompt that is too large',
        {
          '/r/prompts/dienstplan-report.md': {
            kind: 'file',
            text: 'x'.repeat(routineFileLimits.promptBytes + 1),
          },
        },
        {
          code: 'routine_prompt',
          routine: 'dienstplan-report',
          reason: 'too_large',
          field: 'generate.prompt',
        },
      ],
      [
        'a template others may write',
        {
          '/r/wiki-hygiene.md': {
            kind: 'file',
            text: hygieneTemplate,
            mode: 0o646,
          },
        },
        {
          code: 'routine_template',
          routine: 'wiki-hygiene',
          reason: 'mode',
          field: 'template',
        },
      ],
      [
        'a template that is too large',
        {
          '/r/templates/dienstplan-report.md': {
            kind: 'file',
            text: `${reportTemplate}${'x'.repeat(routineFileLimits.templateBytes)}`,
          },
        },
        {
          code: 'routine_template',
          routine: 'dienstplan-report',
          reason: 'too_large',
          field: 'template',
        },
      ],
      [
        'a template with a field of no block',
        {
          '/r/templates/dienstplan-report.md': {
            kind: 'file',
            text: reportTemplate.replace('{{text}}', '{{ort}}'),
          },
        },
        {
          code: 'template_field_unknown',
          routine: 'dienstplan-report',
          field: 'template',
          line: 3,
        },
      ],
      [
        'a template that never repeats a block',
        { '/r/wiki-hygiene.md': { kind: 'file', text: 'Bericht\n' } },
        {
          code: 'template_block_unused',
          routine: 'wiki-hygiene',
          field: 'template',
        },
      ],
    ],
  )('refuses %s', (_name, change, problem) => {
    expect(loadRoutines('/r', memoryTree(folder(change)))).toEqual({
      ok: false,
      ...problem,
    });
  });

  it('refuses more routines than the limit', () => {
    const many = Object.fromEntries(
      Array.from({ length: routineFileLimits.routines + 1 }, (_, index) => [
        `/r/routine-${String(index)}.yaml`,
        { kind: 'file', text: '' } satisfies Entry,
      ]),
    );
    expect(
      loadRoutines('/r', memoryTree({ '/r': { kind: 'dir' }, ...many })),
    ).toEqual({
      ok: false,
      code: 'routines_too_many',
    });
  });

  it('stops at the first routine with a problem, by ID', () => {
    const result = loadRoutines(
      '/r',
      memoryTree(
        folder({
          '/r/dienstplan-report.yaml': { kind: 'file', text: 'schema: x\n' },
          '/r/wiki-hygiene.yaml': { kind: 'file', text: 'schema: y\n' },
        }),
      ),
    );
    expect(result).toMatchObject({ routine: 'dienstplan-report' });
  });

  it('never names a path of the file system or a value of a file', () => {
    const canary = 'canary-in-the-routine';
    const result = loadRoutines(
      '/r',
      memoryTree(
        folder({
          '/r/wiki-hygiene.yaml': {
            kind: 'file',
            text: hygiene.replace('channel: file', `channel: ${canary}`),
          },
        }),
      ),
    );
    expect(result).toMatchObject({
      ok: false,
      code: 'routine_channel_unknown',
    });
    expect(JSON.stringify(result)).not.toContain('canary');
    expect(JSON.stringify(result)).not.toContain('/r');
  });

  it('refuses a path that is not a string', () => {
    expect(() => loadRoutines(1 as unknown as string)).toThrow(TypeError);
  });

  it('has frozen and unique codes', () => {
    expect(Object.isFrozen(routineLoadCodes)).toBe(true);
    expect(new Set(routineLoadCodes).size).toBe(routineLoadCodes.length);
  });
});
