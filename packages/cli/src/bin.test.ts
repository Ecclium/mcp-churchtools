import { readFileSync } from 'node:fs';

import { tokenVariableName } from '@ecclium/mcp-churchtools-core';
import { describe, expect, it } from 'vitest';

import { exitCodes } from './exit-codes.js';

const here = new URL('./', import.meta.url);

const source = (path: string): string =>
  readFileSync(new URL(path, here), 'utf8');

// Code without comments, so that a word in a comment counts for nothing.
const code = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('the executable of the command line', () => {
  const body = code(source('bin.ts'));

  it('starts with the line that runs it with node', () => {
    expect(source('bin.ts').split('\n')[0]).toBe('#!/usr/bin/env node');
  });

  // Only the takeover of the environment loads with the executable. The
  // command line and the start over stdio load with import() after it, so
  // that the start over stdio never loads main.ts and its node:util
  // (ADR 0054, ADR 0055).
  it('imports only the takeover of the environment and loads the rest later', () => {
    expect(body.match(/^import .*$/gm)).toEqual([
      "import { takeEnvironment } from './environment.js';",
    ]);
    expect(body.match(/\bfrom '[^']*'/g)).toEqual(["from './environment.js'"]);
    expect(body.match(/\bimport\([^)]*\)/g)).toEqual([
      "import('./stdio/index.js')",
      "import('./main.js')",
    ]);
  });

  it('takes the token out of the environment before anything else', () => {
    const takeover = /\btakeEnvironment\(process\.env, \['([^']*)'\]\)/.exec(
      body,
    );
    expect(takeover?.[1]).toBe(tokenVariableName);
    expect(body.match(/\btakeEnvironment\(/g)).toHaveLength(1);
    const first = body.indexOf('takeEnvironment(');
    expect(body.indexOf('process.')).toBe(body.indexOf('process.env'));
    expect(first).toBeLessThan(body.indexOf('process.env'));
    expect(first).toBeLessThan(body.indexOf('process.argv'));
    expect(first).toBeLessThan(body.indexOf('import('));
  });

  it('ends with the internal error and no text when the takeover fails', () => {
    expect(body).toContain(`process.exitCode = ${String(exitCodes.internal)};`);
    expect(body).not.toMatch(/\bconsole\b|\bstderr\b|\bstdout\b|writeSync/);
  });

  // A guard such as import.meta.main would turn the command into a silent
  // exit with 0 once a bundle imports this code, and process.exit could
  // cut off an answer on stdout (ADR 0055).
  it('hands ecclium stdio to the start over stdio and every other call to run, once each and unguarded', () => {
    expect(body).toContain("process.argv[2] === 'stdio'");
    expect(body.match(/\bstartStdio\(/g)).toHaveLength(1);
    expect(body).toContain(
      'await startStdio(process.argv.slice(3), environment);',
    );
    expect(body.match(/\brun\(/g)).toHaveLength(1);
    expect(body).toContain(
      'process.exitCode = run(process.argv.slice(2), environment);',
    );
    expect(body).not.toMatch(/import\.meta|\bprocess\.exit\(/);
  });

  it('is the executable ecclium of the package', () => {
    const manifest: unknown = JSON.parse(source('../package.json'));
    expect(manifest).toMatchObject({ bin: { ecclium: './dist/bin.js' } });
  });
});
