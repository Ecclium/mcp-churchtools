// A stand-in for `ecclium stdio` in the tests of the smoke test. It speaks
// JSON-RPC over stdio in both eras, answers the seven tools with synthetic
// canary values and writes log, audit lines on stderr and an audit file in
// the form of the real server. FAKE_SCENARIO breaks one thing at a time,
// so that each check of the smoke test can be seen to fail. FAKE_RECORD
// names a folder that receives, per process, the environment it got and
// the tools it was asked to call. The real server stands in the other
// tests of the smoke test.
import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const env = process.env;
const scenario = env['FAKE_SCENARIO'] ?? 'normal';
const canary = env['FAKE_CANARY'] ?? 'canary';
const personsToolset = env['ECCLIUM_TOOLSETS'] === 'persons';
const calls: string[] = [];

const record = (): void => {
  const target = env['FAKE_RECORD'];
  if (target === undefined) return;
  const variables = Object.fromEntries(
    Object.keys(env)
      .sort()
      .map((name) => [name, name.startsWith('ECCLIUM_') ? env[name] : '']),
  );
  writeFileSync(
    join(target, `${String(process.pid)}.json`),
    JSON.stringify({ variables, calls }),
  );
};
record();

const stateDir = env['ECCLIUM_STATE_DIR'] ?? '';
const auditFolder = join(stateDir, 'audit');
mkdirSync(auditFolder, { recursive: true, mode: 0o700 });
const auditFile = join(
  auditFolder,
  `audit-2026-10-23-120000-${String(process.pid)}-1.jsonl`,
);

const log = (line: Record<string, unknown>): void => {
  process.stderr.write(`${JSON.stringify(line)}\n`);
};
const event = (name: string, fields: Record<string, unknown> = {}): void => {
  log({ ts: new Date().toISOString(), level: 'info', event: name, ...fields });
};
const audit = (tool: string, errorCode?: string): void => {
  const line = {
    v: 1,
    eventId: randomUUID(),
    ts: new Date().toISOString(),
    type: 'tool_call',
    tenantId: 'default',
    actor: { kind: 'service', id: 'stdio:local-stdio' },
    mode: 'interactive',
    tool,
    outcome: errorCode === undefined ? 'ok' : 'error',
    objectRefs: [],
    ...(errorCode === undefined ? {} : { errorCode }),
    durationMs: 1,
  };
  appendFileSync(auditFile, `${JSON.stringify(line)}\n`);
  log(line);
};
const send = (message: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

process.stderr.write('Hinweis: Das Toolset persons ist eingeschaltet.\n');
if (scenario === 'foreign-stdout') process.stdout.write('hallo\n');
if (scenario === 'token-stderr') {
  process.stderr.write(
    readFileSync(env['ECCLIUM_CHURCHTOOLS_TOKEN_FILE'] ?? '', 'utf8'),
  );
}

const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};
const toolNames = [
  ...(personsToolset
    ? [
        'ct_groups_get',
        'ct_groups_get_members',
        'ct_groups_search',
        'ct_persons_get',
        'ct_persons_get_groups',
        'ct_persons_search',
      ]
    : []),
  'ct_whoami',
  ...(scenario === 'write-tool' ? ['ct_wiki_page_create'] : []),
];

const result = (data: Record<string, unknown>): Record<string, unknown> => ({
  content: [
    {
      type: 'text',
      text: scenario === 'text-mismatch' ? '{}' : JSON.stringify(data),
    },
  ],
  structuredContent: data,
});

// The masked forms the pipeline gives an address, or none.
const emails: Readonly<Record<string, string>> = {
  'masked-letter': `m***@example.org`,
  'masked-star': `****@example.org`,
  'masked-literal': '[masked]',
};

const callTool = (name: string, args: Record<string, unknown>): unknown => {
  calls.push(name);
  record();
  if (name === 'ct_whoami') {
    event('http_response', { status: 200 });
    event('http_response', { status: 200 });
    audit(name);
    if (scenario === 'text-stderr') {
      process.stderr.write(`Warnung ${canary}Konto\n`);
    }
    const rights =
      scenario === 'security-level'
        ? [{ right: 'security level person', ids: [1], idCount: 1 }]
        : scenario === 'group-level'
          ? [{ right: 'security level group', ids: [1], idCount: 1 }]
          : [{ right: 'view' }];
    return result({
      id: 4711,
      firstName:
        scenario === 'lone-surrogate' ? `${canary}\uD800` : `${canary}Konto`,
      lastName: `${canary}Dienst`,
      email: emails[scenario] ?? null,
      rights: {
        status: 'known',
        modules: [{ module: 'churchwiki', rights }],
      },
    });
  }
  const wrap = (text: string): string =>
    `<<data-a1b2c3d4e5f6a7b8>>${text}<</data-a1b2c3d4e5f6a7b8>>`;
  if (name === 'ct_persons_get') {
    event('http_response', { status: 200 });
    audit(name);
    return result({
      id: args['personId'],
      firstName: `${canary}Erika`,
      lastName: `${canary}Muster`,
      isArchived: false,
      ...(scenario === 'person-extra' ? { email: 'x@example.org' } : {}),
    });
  }
  if (name === 'ct_persons_get_groups') {
    event('http_response', { status: 200 });
    audit(name);
    const groupName = `${canary}Gruppe`;
    return result({
      personId: args['personId'],
      groups: [
        {
          groupId: 921,
          groupName:
            scenario === 'membership-no-envelope' ? groupName : wrap(groupName),
          groupTypeRoleId: 8,
          groupMemberStatus: 'active',
        },
      ],
      more: false,
      notice: null,
    });
  }
  if (name === 'ct_groups_get') {
    event('http_response', { status: 200 });
    audit(name);
    const note = `${canary}Notiz`;
    if (scenario === 'group-no-details') {
      return result({
        id: args['groupId'],
        name: wrap(`${canary}Gruppe`),
        details: null,
        notice: 'ChurchTools sent no details of this group.',
      });
    }
    return result({
      id: args['groupId'],
      name: wrap(`${canary}Gruppe`),
      details: {
        meetingTime: wrap(`${canary}Dienstag`),
        note: scenario === 'group-bare-note' ? note : wrap(note),
        maxMembers: 12,
        targetGroupId: null,
        dateOfFoundation: '2020-01-01',
        endDate: null,
      },
      notice: null,
    });
  }
  if (name === 'ct_groups_get_members') {
    event('http_response', { status: 200 });
    audit(name);
    return result({
      groupId: args['groupId'],
      page: 1,
      members: [
        {
          personId: 811,
          firstName: `${canary}Erika`,
          lastName: `${canary}Muster`,
          groupTypeRoleId: 8,
          groupMemberStatus: scenario === 'member-status' ? 'Aktiv' : 'active',
        },
      ],
      more: false,
      notice: null,
    });
  }
  const query = typeof args['query'] === 'string' ? args['query'] : '';
  if (query.trim() === '') {
    if (scenario === 'blank-request') event('http_response', { status: 200 });
    audit(name, 'validation');
    return {
      content: [{ type: 'text', text: 'The search term is invalid.' }],
      isError: true,
    };
  }
  event('http_response', { status: 200 });
  if (name === 'ct_persons_search') {
    audit(name);
    if (query.startsWith('zq') || scenario === 'no-hits') {
      return result({ persons: [], more: false, notice: 'No person matched.' });
    }
    if (scenario === 'leak-log') event('debug', { value: `${canary}Erika` });
    return result({
      persons: [
        {
          id: 811,
          firstName: `${canary}Erika`,
          lastName: `${canary}Muster`,
          ...(scenario === 'extra-field' ? { email: 'x@example.org' } : {}),
        },
      ],
      more: false,
      notice: null,
    });
  }
  if (scenario !== 'audit-gap') audit(name);
  const groupName = `${canary}Gruppe`;
  return result({
    groups: [
      {
        id: 921,
        name:
          scenario === 'no-envelope'
            ? groupName
            : `<<data-a1b2c3d4e5f6a7b8>>${groupName}<</data-a1b2c3d4e5f6a7b8>>`,
      },
    ],
    more: false,
    notice: null,
  });
};

const reader = createInterface({ input: process.stdin });
reader.on('line', (line) => {
  const message = JSON.parse(line) as Record<string, unknown>;
  const id = message['id'];
  const params = (message['params'] ?? {}) as Record<string, unknown>;
  if (typeof id !== 'number') return;
  switch (message['method']) {
    case 'server/discover':
    case 'initialize':
      send({ jsonrpc: '2.0', id, result: { serverInfo: { name: 'fake' } } });
      return;
    case 'tools/list':
      send({
        jsonrpc: '2.0',
        id,
        result: {
          tools: toolNames.map((name) => ({ name, annotations })),
        },
      });
      return;
    case 'tools/call':
      send({
        jsonrpc: '2.0',
        id,
        result: callTool(
          String(params['name']),
          (params['arguments'] ?? {}) as Record<string, unknown>,
        ),
      });
      return;
    default:
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'none' } });
  }
});
reader.on('close', () => {
  event('audit_file_closed', { count: 0 });
  event('stdio_closed', { count: 0 });
  process.exitCode = scenario === 'exit-1' ? 1 : 0;
});
