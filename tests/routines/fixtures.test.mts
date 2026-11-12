import { chmodSync, cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadRoutines } from '@ecclium/mcp-churchtools-workflows';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// The routines of the free core not yet shipped in routines/, as fixtures
// with their prompts and templates, loaded from disk with the real file
// functions; shipped.test.mts loads the shipped ones. A checkout
// gives files the rights its umask allows, and the loader refuses a file
// the group may write, so the test copies the folder and sets the rights
// itself.

const fixtures = fileURLToPath(new URL('routines', import.meta.url));

let root = '';
let folder = '';

// Every folder 0755 and every file 0644, as an operator would set them.
const setRights = (path: string): void => {
  chmodSync(path, 0o755);
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const inner = join(path, entry.name);
    if (entry.isDirectory()) setRights(inner);
    else chmodSync(inner, 0o644);
  }
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ecclium-routines-'));
  folder = join(root, 'routines');
  cpSync(fixtures, folder, { recursive: true });
  setRights(folder);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('the routines of the fixtures', () => {
  it('load with their prompts and templates', () => {
    const loaded = loadRoutines(folder);
    expect(loaded).toMatchObject({ ok: true });
    if (!loaded.ok) return;
    expect(loaded.routines.map(({ routine }) => routine.id)).toEqual([
      'termin-vorschau',
      'wiki-hygiene',
    ]);
    const [preview, hygiene] = loaded.routines;
    expect(preview?.prompt).toContain('Gemeindebrief');
    expect(preview?.routine.output).toMatchObject({
      target: 'draft',
      channel: 'file',
    });
    expect(hygiene?.routine.checks?.map(({ check }) => check)).toEqual([
      'stalePages',
      'brokenLinks',
    ]);
    expect(hygiene).not.toHaveProperty('prompt');
  });

  it('are refused when the group may write the folder of templates', () => {
    chmodSync(join(folder, 'templates'), 0o775);
    expect(loadRoutines(folder)).toMatchObject({
      ok: false,
      code: 'routine_template',
      routine: 'termin-vorschau',
      reason: 'mode',
    });
  });

  it('are refused when a routine is a file the group may write', () => {
    chmodSync(join(folder, 'wiki-hygiene.yaml'), 0o664);
    expect(loadRoutines(folder)).toMatchObject({
      ok: false,
      code: 'routine_file',
      routine: 'wiki-hygiene',
      reason: 'mode',
    });
  });
});
