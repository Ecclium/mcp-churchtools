import type { Linter } from 'eslint';

import type { Boundaries, PlaceKey } from './boundaries.mts';

// ESLint rules for the code of the packages, generated from boundaries.json
// and loaded by eslint.config.mjs. dependency-cruiser sees imports; these
// rules see what code does with them: writing to stdout or stderr, using
// console, and importing the MCP SDK in any form.
//
// Every restriction carries an id such as [arch:stdout] and its ADR in the
// message, so the tests can prove each one on its own. Several restrictions
// share an ESLint rule, and a later configuration block replaces the options
// of that rule as a whole. Each block therefore repeats every restriction it
// does not lift.

/** What the rules keep out of the packages, each with its own id. */
export const concernIds = [
  'console',
  'stdout',
  'stderr',
  'process',
  'mcp-sdk',
  'dynamic-import',
  'require',
] as const;

type Concern = (typeof concernIds)[number];

/** The ESLint rules that carry the restrictions. */
export const architectureRuleIds: readonly string[] = [
  'no-restricted-globals',
  'no-restricted-imports',
  'no-restricted-properties',
  'no-restricted-syntax',
];

/** Concerns that some places may lift, and where boundaries.json lists them. */
const liftable: readonly (readonly [Concern, PlaceKey])[] = [
  ['stdout', 'stdout'],
  ['stderr', 'stderr'],
  ['mcp-sdk', 'mcpSdk'],
];

const sources = '{ts,mts,cts}';

function messages(boundaries: Boundaries): Record<Concern, string> {
  const adr = (key: PlaceKey): string => `ADR ${boundaries.places[key].adr}`;
  return {
    console:
      '[arch:console] Code in the packages writes through the logger or the output module of the command line, never through console (ADR 0018).',
    stdout: `[arch:stdout] Only the output module of the command line writes to stdout. In the stdio mode stdout carries the MCP protocol (${adr('stdout')}).`,
    stderr: `[arch:stderr] Only the logger and the output module of the command line write to stderr (${adr('stderr')}).`,
    process:
      '[arch:process] Use process only through a property such as process.env. Passed on or taken apart, it hides writes to stdout and stderr from these rules (ADR 0018).',
    'mcp-sdk': `[arch:mcp-sdk] Only the mount in core and the server import the MCP SDK (${adr('mcpSdk')}).`,
    'dynamic-import':
      '[arch:dynamic-import] import() takes a fixed string, so that the architecture checks see what it loads (ADR 0022).',
    require:
      '[arch:require] createRequire loads modules past the architecture checks. Use import instead (ADR 0022).',
  };
}

/** Rule settings for code that may do what `allowed` names, and no more. */
function restrictions(
  message: Record<Concern, string>,
  allowed: ReadonlySet<Concern>,
): Record<string, Linter.RuleEntry> {
  const forbid = (concern: Concern): boolean => !allowed.has(concern);
  // Writes to a file descriptor: 1 is stdout, 2 is stderr.
  const writesTo = (fd: 1 | 2, concern: Concern) => [
    {
      selector: `CallExpression[arguments.0.value=${String(fd)}]:matches([callee.name=/^write(Sync)?$/], [callee.property.name=/^write(Sync)?$/])`,
      message: message[concern],
    },
    {
      selector: `Property[key.name='fd'][value.value=${String(fd)}]`,
      message: message[concern],
    },
  ];
  const processImports = (names: readonly string[], concern: Concern) =>
    ['node:process', 'process'].map((name) => ({
      name,
      importNames: [...names],
      message: message[concern],
    }));
  return {
    'no-restricted-globals': [
      'error',
      { name: 'console', message: message.console },
    ],
    'no-restricted-properties': [
      'error',
      ...['globalThis', 'global'].flatMap((object) => [
        { object, property: 'console', message: message.console },
        { object, property: 'process', message: message.process },
      ]),
      ...(forbid('stdout')
        ? [{ object: 'process', property: 'stdout', message: message.stdout }]
        : []),
      ...(forbid('stderr')
        ? [{ object: 'process', property: 'stderr', message: message.stderr }]
        : []),
    ],
    'no-restricted-imports': [
      'error',
      {
        paths: [
          ...['node:console', 'console'].map((name) => ({
            name,
            message: message.console,
          })),
          ...processImports(['default'], 'process'),
          ...(forbid('stdout') ? processImports(['stdout'], 'stdout') : []),
          ...(forbid('stderr') ? processImports(['stderr'], 'stderr') : []),
          ...(forbid('stdout')
            ? ['node:tty', 'tty'].map((name) => ({
                name,
                message: message.stdout,
              }))
            : []),
          ...['node:module', 'module'].map((name) => ({
            name,
            importNames: ['createRequire'],
            message: message.require,
          })),
        ],
        patterns: forbid('mcp-sdk')
          ? [{ regex: '^@modelcontextprotocol/', message: message['mcp-sdk'] }]
          : [],
      },
    ],
    'no-restricted-syntax': [
      'error',
      {
        selector: 'ImportExpression[source.value=/^(node:)?console$/]',
        message: message.console,
      },
      {
        selector: 'ImportExpression[source.value=/^(node:)?process$/]',
        message: message.process,
      },
      {
        // process as a value: anything but process.name or process['name'],
        // and not a property name or key that happens to read process.
        selector: [
          "Identifier[name='process']:not(",
          'MemberExpression[computed=false] > Identifier.object, ',
          "MemberExpression[computed=true][property.type='Literal'] > Identifier.object, ",
          'MemberExpression > Identifier.property, ',
          'Property > Identifier.key, ',
          'PropertyDefinition > Identifier.key, ',
          'MethodDefinition > Identifier.key, ',
          'TSPropertySignature > Identifier.key',
          ')',
        ].join(''),
        message: message.process,
      },
      {
        selector: "ImportExpression:not([source.type='Literal'])",
        message: message['dynamic-import'],
      },
      ...(forbid('stdout') ? writesTo(1, 'stdout') : []),
      ...(forbid('stderr') ? writesTo(2, 'stderr') : []),
      ...(forbid('mcp-sdk')
        ? ['ImportExpression', 'TSImportType'].map((node) => ({
            // A selector ends its regular expression at the first slash, so
            // the slash after the scope is written as \x2F.
            selector: String.raw`${node}[source.value=/^@modelcontextprotocol\x2F/]`,
            message: message['mcp-sdk'],
          }))
        : []),
    ],
  };
}

/**
 * Builds the configuration blocks: one for all code in the packages, then
 * one for each place that lifts a restriction. Longer paths come later, so
 * a place inside another one wins and keeps what the outer place allows.
 *
 * @param boundaries - The checked content of boundaries.json.
 * @returns Flat configuration blocks for ESLint.
 */
export function architectureLintConfig(
  boundaries: Boundaries,
): Linter.Config[] {
  const message = messages(boundaries);
  const lifted = liftable.flatMap(([concern, key]) =>
    boundaries.places[key].paths.map((path) => ({ concern, path })),
  );
  const paths = [...new Set(lifted.map((entry) => entry.path))].sort(
    (a, b) => a.length - b.length,
  );
  return [
    {
      name: 'architecture: packages',
      files: [`packages/*/src/**/*.${sources}`],
      rules: restrictions(message, new Set()),
    },
    ...paths.map((path) => ({
      name: `architecture: ${path}`,
      files: [path.endsWith('/') ? `${path}**/*.${sources}` : path],
      rules: restrictions(
        message,
        new Set(
          lifted
            .filter((entry) => path.startsWith(entry.path))
            .map((entry) => entry.concern),
        ),
      ),
    })),
  ];
}
