import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const here = new URL('./', import.meta.url);

const source = (path: string): string =>
  readFileSync(new URL(path, here), 'utf8');

// Code without comments, so that a word in a comment counts for nothing.
const code = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('the executable of the command line', () => {
  const bin = source('bin.ts');

  it('starts with the line that runs it with node', () => {
    expect(bin.split('\n')[0]).toBe('#!/usr/bin/env node');
  });

  // A guard such as import.meta.main would turn the command into a silent
  // exit with 0 once a bundle imports this code (ADR 0055).
  it('hands the arguments and the environment to run, once and unguarded', () => {
    const body = code(bin);
    expect(body.match(/^import .*$/gm)).toEqual([
      "import { run } from './main.js';",
    ]);
    expect(body.match(/\brun\(/g)).toHaveLength(1);
    expect(body).toContain(
      'process.exitCode = run(process.argv.slice(2), process.env);',
    );
    expect(body).not.toMatch(/import\.meta|\bif\b/);
  });

  it('is the executable ecclium of the package', () => {
    const manifest: unknown = JSON.parse(source('../package.json'));
    expect(manifest).toMatchObject({ bin: { ecclium: './dist/bin.js' } });
  });
});
