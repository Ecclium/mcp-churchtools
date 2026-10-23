import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { makeCanary } from '@ecclium/mcp-churchtools-testkit';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { fixedSentences } from '../packages/core/src/errors/index.ts';
import {
  maxResultBytes,
  resultBytes,
} from '../packages/core/src/pipeline/stages.ts';
import { blockedMarker, guardPreload } from './support/no-network.mts';
import {
  at,
  type Era,
  eras,
  type Finished,
  type Json,
  jsonLines,
  modern,
  protocolViolations,
  type Session,
  startSession,
} from './support/stdio-session.mts';

// In the stdio mode stdout carries only the MCP protocol (ADR 0053). Rules
// read the code; this test watches a real process. A child built like a
// composition root, tests/fixtures/stdio/server.mts, serves the mount over
// its real stdin and stdout, and the test plays the client in both eras: a
// whole session with an unknown tool, a refused input, a line that is no
// JSON, an error from the test double of ChurchTools and a cancelled call,
// then more calls. Every line on stdout must be one JSON-RPC 2.0 message.
// The child runs from source with the network guard inherited through
// NODE_OPTIONS and an environment of its own otherwise. Package tests
// cannot start child processes, so this test lives here.

const workspace = fileURLToPath(new URL('../', import.meta.url));
const fixture = fileURLToPath(
  new URL('fixtures/stdio/server.mts', import.meta.url),
);
const hooks = new URL('fixtures/stdio/hooks.mts', import.meta.url).href;

const stdioEntry = 'packages/server/src/stdio/index.ts';
const stdioEntryByName = '@ecclium/mcp-churchtools-server/stdio';

/**
 * Whether an import, relative to the workspace or by name, reaches the
 * mount, the SDK or the server past its stdio entry.
 */
const bypassesStdioEntry = (path: string): boolean =>
  path.startsWith('packages/core/src/mcp/') ||
  path.startsWith('@ecclium/mcp-churchtools-core/mcp') ||
  path.startsWith('@modelcontextprotocol/') ||
  (path.startsWith('packages/server/src/') &&
    !path.startsWith('packages/server/src/stdio/')) ||
  (path.startsWith('@ecclium/mcp-churchtools-server') &&
    path !== stdioEntryByName);

/**
 * Imports of the fixture that reach the mount or the SDK past the stdio
 * entry of the server, and a missing import of that entry.
 *
 * @param source - The text of the fixture.
 * @returns One entry per problem, empty when there is none.
 */
function mountBypasses(source: string): string[] {
  const imported = ts
    .preProcessFile(source, true, true)
    .importedFiles.map(({ fileName }) =>
      fileName.startsWith('.')
        ? relative(workspace, join(dirname(fixture), fileName))
        : fileName,
    );
  const entered =
    imported.includes(stdioEntry) || imported.includes(stdioEntryByName);
  return [
    ...imported.filter(bypassesStdioEntry),
    ...(entered ? [] : [`no import of ${stdioEntry}`]),
  ];
}

/** A session with the fixture, and the token it was given. */
interface FixtureSession extends Session {
  readonly token: string;
}

const children: ChildProcessWithoutNullStreams[] = [];
afterAll(() => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
});

const start = (
  scenario: 'serve' | 'stray-line' | 'connect' | 'audit-file',
  env: Readonly<Record<string, string>> = {},
): FixtureSession => {
  const token = makeCanary('token').value;
  const session = startSession(
    ['--conditions=@ecclium/source', `--import=${hooks}`, fixture, scenario],
    {
      // Only these variables: the network guard, the token and those of a
      // scenario. The shell that runs the tests may hold variables of the
      // project.
      NODE_OPTIONS: guardPreload,
      STDIO_FIXTURE_TOKEN: token,
      ...env,
    },
  );
  children.push(session.child);
  return { ...session, token };
};

// Notes of the echo tool full of quotes, which cost the most on the wire,
// so that the result lands exactly on the limit of the pipeline. Each note
// travels inside the data envelope, whose boundary has 16 hexadecimal
// digits whatever the child draws.
const wrap = (text: string): string =>
  `<<data-${'0'.repeat(16)}>>${text}<</data-${'0'.repeat(16)}>>`;
const bytesOf = (notes: readonly string[]): number =>
  resultBytes({ notes: notes.map(wrap) });
const notesAtLimit = (extra: number): string[] => {
  const full = '"'.repeat(2000);
  const notes: string[] = [];
  while (bytesOf([...notes, full]) <= maxResultBytes) notes.push(full);
  const rest = maxResultBytes - bytesOf([...notes, '']);
  const quotes = Math.floor(rest / 6);
  const letters = (rest - 6 * quotes) / 2 + extra;
  return [...notes, '"'.repeat(quotes) + 'a'.repeat(letters)];
};

describe('the notes at the limit', () => {
  it('fill exactly 64 KiB as the pipeline counts, and two bytes more with one letter more', () => {
    expect(bytesOf(notesAtLimit(0))).toBe(maxResultBytes);
    expect(bytesOf(notesAtLimit(1))).toBe(maxResultBytes + 2);
    for (const note of notesAtLimit(1)) {
      expect(note.length).toBeLessThanOrEqual(2000);
    }
  });
});

/** What a whole session in one era left behind. */
interface Run {
  readonly session: FixtureSession;
  readonly opened: Json;
  readonly cancelledAudit: Json;
  readonly finished: Finished;
}

/**
 * Runs the whole session. Requests carry ids 2 to 13; the line with id 7 is
 * broken on purpose and request 9 is cancelled, so neither gets an answer.
 */
async function runSession(era: Era): Promise<Run> {
  const session = start('serve');
  const call = (id: number, name: string, args: Json): Promise<Json> => {
    session.send({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: era.params({ name, arguments: args }),
    });
    return session.response(id);
  };
  const list = (id: number): Promise<Json> => {
    session.send({
      jsonrpc: '2.0',
      id,
      method: 'tools/list',
      params: era.params({}),
    });
    return session.response(id);
  };
  const opened = await era.open(session);
  await list(2);
  await call(3, 'ct_example_echo', {
    email: 'max.mustermann@example.org',
    notes: ['a'],
  });
  await call(4, 'ct_example_profile', {});
  await call(5, 'ct_not_there', { a: 1 });
  await call(6, 'ct_example_echo', { unknown: 'x' });
  session.write('{"jsonrpc":"2.0","id":7,\n');
  await call(8, 'ct_example_profile', {});
  // The double holds the answer to this call for a minute, so only the
  // cancellation can end it before stdin closes.
  session.send({
    jsonrpc: '2.0',
    id: 9,
    method: 'tools/call',
    params: era.params({ name: 'ct_example_profile', arguments: {} }),
  });
  session.send({
    jsonrpc: '2.0',
    method: 'notifications/cancelled',
    params: era.params({ requestId: 9, reason: 'test' }),
  });
  const cancelledAudit = await session.logged(
    (line) =>
      line['type'] === 'tool_call' &&
      line['tool'] === 'ct_example_profile' &&
      line['errorCode'] === 'network',
  );
  await list(10);
  await call(11, 'ct_example_echo', { notes: ['b'] });
  await call(12, 'ct_example_echo', { notes: notesAtLimit(0) });
  await call(13, 'ct_example_echo', { notes: notesAtLimit(1) });
  const finished = await session.finish();
  return { session, opened, cancelledAudit, finished };
}

const timeout = 60_000;

describe.each(eras)('the stdio server in the $name era', { timeout }, (era) => {
  let run: Run;
  beforeAll(async () => {
    run = await runSession(era);
  }, timeout);

  const lines = (): string[] => run.finished.stdout.split('\n').slice(0, -1);
  const answer = (id: number): Json | undefined =>
    jsonLines(run.finished.stdout).find((line) => line['id'] === id);
  const lineOf = (id: number): string =>
    lines().find((line) => (JSON.parse(line) as Json)['id'] === id) ?? '';

  it('writes only JSON-RPC 2.0, line by line, and ends normally', () => {
    expect(run.finished.code).toBe(0);
    expect(protocolViolations(run.finished.stdout)).toEqual([]);
    expect(lines()).toHaveLength(11);
  });

  it('answers every request but the broken line and the cancelled call', () => {
    const ids = jsonLines(run.finished.stdout).map((line) => line['id']);
    expect(ids).toEqual([1, 2, 3, 4, 5, 6, 8, 10, 11, 12, 13]);
    for (const line of jsonLines(run.finished.stdout)) {
      expect(line['error'], String(line['id'])).toBeUndefined();
    }
  });

  it('opens the era and lists the tools without listChanged', () => {
    expect(at(run.opened, 'result', 'capabilities')).toEqual({
      tools: { listChanged: false },
    });
    const names = (id: number) =>
      (at(answer(id), 'result', 'tools') as readonly Json[]).map(
        (tool) => tool['name'],
      );
    // The server only reads by default, so the write tool is not listed.
    const tools = ['ct_example_echo', 'ct_example_profile'];
    expect([...names(2)].sort()).toEqual(tools);
    expect([...names(10)].sort()).toEqual(tools);
  });

  it('returns masked data, also from the double', () => {
    expect(at(answer(3), 'result', 'structuredContent', 'email')).toBe(
      'm***@example.org',
    );
    expect(at(answer(4), 'result', 'structuredContent')).toEqual({
      id: 1,
      firstName: 'Max',
      lastName: 'Mustermann',
      email: 'm***@example.org',
    });
    expect(at(answer(11), 'result', 'isError')).toBeUndefined();
  });

  it('ends an unknown tool, a refused input and an error of the double with the fixed sentence', () => {
    const sentence = (id: number) => at(answer(id), 'result', 'content', 0);
    expect(at(answer(5), 'result', 'isError')).toBe(true);
    expect(sentence(5)).toEqual({
      type: 'text',
      text: fixedSentences.not_found,
    });
    expect(sentence(6)).toEqual({
      type: 'text',
      text: fixedSentences.validation,
    });
    expect(sentence(8)).toEqual({
      type: 'text',
      text: fixedSentences.upstream,
    });
  });

  it('cancels a call: the audit records it, and the client gets no answer', () => {
    expect(run.cancelledAudit).toMatchObject({
      outcome: 'error',
      errorCode: 'network',
    });
    expect(answer(9)).toBeUndefined();
  });

  it('keeps the line of a result at the limit within 64 KiB, and refuses one more letter', () => {
    const atLimit = lineOf(12);
    expect(at(JSON.parse(atLimit), 'result', 'isError')).toBeUndefined();
    expect(
      at(JSON.parse(atLimit), 'result', 'structuredContent', 'notes'),
    ).toHaveLength(notesAtLimit(0).length);
    expect(Buffer.byteLength(`${atLimit}\n`)).toBeLessThanOrEqual(
      maxResultBytes,
    );
    expect(at(answer(13), 'result', 'isError')).toBe(true);
    expect(at(answer(13), 'result', 'content', 0, 'text')).toContain('64 KiB');
  });

  it('never shows the token', () => {
    expect(run.finished.stdout).not.toContain(run.session.token);
    expect(run.finished.stderr).not.toContain(run.session.token);
  });
});

// A tool with sensitivity special at a real audit file and the real fd 2
// (ADR 0028): its first call deletes the file and locks the folder audit,
// so its line cannot reach a file, and its result stays back. The second
// call finds no file the gate could use and does not run. A locked folder
// locks nothing for root, so the case does not run as root.
describe.skipIf(process.getuid?.() === 0)(
  'a tool with sensitivity special at a real audit file',
  { timeout },
  () => {
    const data = makeCanary('name');
    let stateDir = '';
    let first: Json = {};
    let second: Json = {};
    let finished: Finished;

    beforeAll(async () => {
      stateDir = mkdtempSync(join(tmpdir(), 'ecclium-stdio-audit-'));
      const session = start('audit-file', {
        STDIO_FIXTURE_STATE_DIR: stateDir,
        STDIO_FIXTURE_DATA: data.value,
      });
      await modern.open(session);
      session.send({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: modern.params({ name: 'ct_test_special', arguments: {} }),
      });
      first = await session.response(2);
      session.send({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: modern.params({ name: 'ct_test_special', arguments: {} }),
      });
      second = await session.response(3);
      finished = await session.finish();
    }, timeout);

    afterAll(() => {
      if (stateDir === '') return;
      chmodSync(join(stateDir, 'audit'), 0o700);
      rmSync(stateDir, { recursive: true, force: true });
    });

    it('holds the result back and never writes it to stdout', () => {
      expect(at(first, 'result', 'isError')).toBe(true);
      expect(at(first, 'result', 'content', 0, 'text')).toBe(
        'The call could not be recorded in the audit file, so its result is held back. Ask the operator to check the audit file.',
      );
      expect(finished.stdout).not.toContain(data.value);
      expect(protocolViolations(finished.stdout)).toEqual([]);
    });

    it('says denied in the copy on stderr and logs audit_withheld with the same ID', () => {
      const lines = jsonLines(finished.stderr);
      const audit = lines.filter((line) => line['type'] === 'tool_call');
      expect(audit[0]).toMatchObject({
        tool: 'ct_test_special',
        outcome: 'denied',
        errorCode: 'policy_denied',
      });
      const withheld = lines.filter(
        (line) => line['event'] === 'audit_withheld',
      );
      expect(withheld).toHaveLength(1);
      expect(withheld[0]).toMatchObject({
        level: 'warn',
        code: 'policy_denied',
        eventId: audit[0]?.['eventId'],
      });
      expect(finished.stderr).not.toContain(data.value);
    });

    it('lets the next call not run, since the gate finds no file', () => {
      expect(at(second, 'result', 'content', 0, 'text')).toBe(
        'The audit file of the server cannot record this call now, so the tool did not run. Ask the operator to check the audit file.',
      );
      const audit = jsonLines(finished.stderr).filter(
        (line) => line['type'] === 'tool_call',
      );
      expect(audit[1]).toMatchObject({
        outcome: 'denied',
        errorCode: 'policy_denied',
      });
    });

    it('leaves the deleted file gone and no new one in the locked folder', () => {
      expect(readdirSync(join(stateDir, 'audit'))).toEqual([]);
    });
  },
);

describe('the checks of the stdio test', { timeout }, () => {
  it('hand the network guard to the child', () => {
    expect(process.env['NODE_OPTIONS']?.split(/\s+/)).toContain(guardPreload);
  });

  it('fail on a line of the child that is no JSON-RPC', async () => {
    const session = start('stray-line');
    await modern.open(session);
    const { code, stdout } = await session.finish();
    expect(code).toBe(0);
    expect(protocolViolations(stdout)).toEqual([
      'line 1: a line that is no JSON-RPC',
    ]);
  });

  it('fail on an attempt of the child to connect outside', async () => {
    const session = start('connect');
    await modern.open(session);
    const { code, stderr } = await session.finish();
    expect(code).toBe(70);
    expect(stderr).toContain(blockedMarker);
  });

  it.each([
    ['no line break at the end', '{"jsonrpc":"2.0","id":1,"result":{}}'],
    ['text', 'hello\n'],
    ['an array', '[{"jsonrpc":"2.0","id":1,"result":{}}]\n'],
    ['another version', '{"jsonrpc":"1.0","id":1,"result":{}}\n'],
    ['result and error', '{"jsonrpc":"2.0","id":1,"result":{},"error":{}}\n'],
    ['neither result nor error', '{"jsonrpc":"2.0","id":1}\n'],
    ['an extra member', '{"jsonrpc":"2.0","id":1,"result":{},"x":1}\n'],
    ['an id of another type', '{"jsonrpc":"2.0","id":true,"result":{}}\n'],
    ['an empty line', '\n'],
  ])('find %s on stdout', (_name, text) => {
    expect(protocolViolations(text)).not.toEqual([]);
  });

  it('accept a request, a notification, a result and an error', () => {
    expect(
      protocolViolations(
        [
          '{"jsonrpc":"2.0","id":"a","method":"ping"}',
          '{"jsonrpc":"2.0","method":"notifications/message","params":{}}',
          '{"result":{},"jsonrpc":"2.0","id":2}',
          '{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"x"}}',
          '',
        ].join('\n'),
      ),
    ).toEqual([]);
  });
});

describe('the fixture of the stdio test', () => {
  const source = readFileSync(fixture, 'utf8');

  it('reaches the mount only through the stdio entry of the server', () => {
    expect(mountBypasses(source)).toEqual([]);
  });

  it.each([
    "import { createMcpMount } from '../../../packages/core/src/mcp/mount.ts';",
    "import { createMcpMount } from '@ecclium/mcp-churchtools-core/mcp';",
    "const mount = await import('../../../packages/core/src/mcp/mount.ts');",
    "import { serveStdio } from '@modelcontextprotocol/server/stdio';",
    "export * from '../../../packages/server/src/index.ts';",
    "import * as server from '@ecclium/mcp-churchtools-server';",
  ])('would fail with %s', (line) => {
    expect(mountBypasses(`${source}\n${line}\n`)).not.toEqual([]);
  });

  it('would fail without the stdio entry', () => {
    const without = source
      .split('\n')
      .filter((line) => !line.includes('packages/server/src/stdio/'))
      .join('\n');
    expect(mountBypasses(without)).toEqual([`no import of ${stdioEntry}`]);
  });
});
