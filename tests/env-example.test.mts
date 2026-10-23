import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

import {
  loadConfig,
  type StateDirFileSystem,
  type TokenFileSystem,
  tokenVariableName,
  variableNames,
  variables,
} from '@ecclium/mcp-churchtools-core';
import { makeCanary } from '@ecclium/mcp-churchtools-testkit';
import { describe, expect, it } from 'vitest';

import { environmentSchema } from '../packages/core/src/config/variables.ts';

// .env.example documents every variable of the configuration that holds no
// secret (ADR 0055). This test keeps it in step with the table of
// variables in core: every name once, in table order, with its default.

const text = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
const lines = text.split('\n').slice(0, -1);

const assignment = /^(ECCLIUM_[A-Z0-9_]+)=([^\s#"'`=]+)$/;
const comment = /^#( [^\s].*)?$/;

const assignments = lines.flatMap((line) => {
  const match = assignment.exec(line);
  return match ? [[match[1] ?? '', match[2] ?? ''] as const] : [];
});
const values = Object.fromEntries(assignments);
const comments = lines.filter((line) => line.startsWith('#'));

/** One good token file in memory: the path in the file is a placeholder. */
const goodFile = (): TokenFileSystem => {
  const bytes = new TextEncoder().encode(`${makeCanary('token').value}\n`);
  const state = { position: 0 };
  return {
    openSync: () => {
      state.position = 0;
      return 3;
    },
    fstatSync: () => ({
      isFile: () => true,
      uid: 1000,
      mode: 0o100600,
      size: bytes.length,
    }),
    readSync: (_fd, buffer, offset, length) => {
      const chunk = bytes.subarray(state.position, state.position + length);
      buffer.set(chunk, offset);
      state.position += chunk.length;
      return chunk.length;
    },
    closeSync: () => undefined,
    getuid: () => 1000,
    constants: { O_RDONLY: 0, O_NOFOLLOW: 1, O_NONBLOCK: 2, O_NOCTTY: 4 },
  };
};

/**
 * One good folder of state in memory: the path in the file is a
 * placeholder, a folder of the user with 0700 and no folder audit yet.
 */
const goodFolder = (): StateDirFileSystem => ({
  lstatSync: (path) => {
    if (path.endsWith('/audit')) {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    }
    return {
      isDirectory: () => true,
      isSymbolicLink: () => false,
      uid: 1000,
      mode: 0o40700,
    };
  },
  getuid: () => 1000,
  constants: { O_NOFOLLOW: 1, O_DIRECTORY: 2, O_NOCTTY: 4 },
});

describe('.env.example', () => {
  it('has only comments, empty lines and plain assignments', () => {
    expect(text.endsWith('\n')).toBe(true);
    expect(text).not.toMatch(/\r|\t| \n/);
    for (const line of lines) {
      expect(
        line === '' || comment.test(line) || assignment.test(line),
        line,
      ).toBe(true);
    }
  });

  it('sets every variable without a secret once, in the order of the table', () => {
    expect(assignments.map(([name]) => name)).toEqual(
      variableNames.filter((name) => name !== tokenVariableName),
    );
  });

  it('reads the same with the parser of Node.js', () => {
    expect({ ...parseEnv(text) }).toEqual(values);
  });

  it('gives the defaults of the table and the placeholder address', () => {
    for (const variable of variables) {
      if (variable.defaultValue !== undefined) {
        expect(values[variable.name], variable.name).toBe(
          variable.defaultValue,
        );
      }
    }
    expect(values.ECCLIUM_CHURCHTOOLS_URL).toBe('https://example.church.tools');
  });

  it('passes the schema of the table and loads without a problem', () => {
    expect(environmentSchema.safeParse(values).success).toBe(true);
    const result = loadConfig({
      environment: values,
      transport: 'stdio',
      tokenFiles: goodFile(),
      stateDirFiles: goodFolder(),
    });
    expect(result.report.problems).toEqual([]);
    expect(result.report.warnings).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('names the token variable only in comments, never with a value', () => {
    expect(text).not.toContain(`${tokenVariableName}=`);
    const named = lines.filter((line) =>
      line.split(/[^A-Z0-9_]/).includes(tokenVariableName),
    );
    expect(named.length).toBeGreaterThan(0);
    for (const line of named) expect(line.startsWith('#'), line).toBe(true);
  });

  it('names no variable that the table does not know', () => {
    for (const name of text.match(/ECCLIUM_[A-Z0-9_]*[A-Z0-9]/g) ?? []) {
      expect(variableNames, name).toContain(name);
    }
  });

  // Chapter 9 of brand/README.md: «Sie», ss, quotes «so», no em dash, no
  // exclamation mark, none of the words it lists.
  it('follows the rules of the brand in its comments', () => {
    const prose = comments.join('\n');
    expect(prose).not.toMatch(/[ß—–!"„“”'‚‘’]/);
    expect(prose.split('«').length).toBe(prose.split('»').length);
    expect(prose).not.toMatch(/\b(du|dein|deine|dich|dir)\b/i);
    expect(prose).not.toMatch(
      /revolutionär|nahtlos|einzigartig|smart|magisch|mühelos|einfach|100 % sicher/i,
    );
  });
});
