import type { Linter } from 'eslint';

import type { Boundaries, PlaceKey } from './boundaries.mts';

// ESLint rules for the code of the packages, generated from boundaries.json
// and loaded by eslint.config.mjs. dependency-cruiser sees imports; these
// rules see what code does with them: writing to stdout or stderr, using
// console, loading modules past the import checks, starting processes, and
// importing the MCP SDK.
//
// Every restriction carries an id such as [arch:stdout] and its ADR in the
// message, so the tests can prove each one on its own. Several restrictions
// share an ESLint rule, and a later configuration block replaces the options
// of that rule as a whole. Each block therefore repeats every restriction it
// does not lift.
//
// The rules read code, not what it does at run time. ADR 0018 lists what
// they cannot see.

/** What the rules keep out of the packages, each with its own id. */
export const concernIds = [
  'console',
  'stdout',
  'stderr',
  'process',
  'mcp-sdk',
  'dynamic-import',
  'require',
  'subprocess',
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
      '[arch:process] Use process and globalThis only through a property such as process.env. Passed on or taken apart, they hide writes to stdout and stderr from these rules (ADR 0018).',
    'mcp-sdk': `[arch:mcp-sdk] Only the mount in core and the server import the MCP SDK (${adr('mcpSdk')}).`,
    'dynamic-import':
      '[arch:dynamic-import] import() takes a fixed string, so that the architecture checks see what it loads (ADR 0022).',
    require:
      '[arch:require] Modules are loaded only with import, never through node:module, require or process.getBuiltinModule, which the architecture checks do not see (ADR 0022).',
    subprocess:
      '[arch:subprocess] The packages start no child processes, workers or cluster members, which can share stdout with the MCP protocol (ADR 0018).',
  };
}

/** A module name with and without the prefix node:. */
const builtin = (...names: readonly string[]): string[] =>
  names.flatMap((name) => [`node:${name}`, name]);

/** A selector for import() of the given built-in modules. */
const importOf = (names: string): string =>
  `ImportExpression[source.value=/^(node:)?(${names})$/]`;

/** Rule settings for code that may do what `allowed` names, and no more. */
function restrictions(
  message: Record<Concern, string>,
  allowed: ReadonlySet<Concern>,
): Record<string, Linter.RuleEntry> {
  const forbid = (concern: Concern): boolean => !allowed.has(concern);
  // Output to a file descriptor or its device file: 1 is stdout, 2 is
  // stderr. A selector ends its regular expression at the first slash, so a
  // slash inside one is written as \x2F.
  const writesTo = (fd: 1 | 2, concern: Concern) => [
    {
      selector: `CallExpression[arguments.0.value=${String(fd)}]:matches([callee.name=/^(write|writeSync|writeFile|writeFileSync|appendFile|appendFileSync)$/], [callee.property.name=/^(write|writeSync|writeFile|writeFileSync|appendFile|appendFileSync)$/])`,
      message: message[concern],
    },
    {
      selector: `Property[key.name='fd'][value.value=${String(fd)}]`,
      message: message[concern],
    },
    {
      selector: String.raw`Literal[value=/^\x2F(dev\x2F(${fd === 1 ? 'stdout' : 'stderr'}|fd\x2F${String(fd)})|proc\x2Fself\x2Ffd\x2F${String(fd)})$/]`,
      message: message[concern],
    },
  ];
  const processImports = (names: readonly string[], concern: Concern) =>
    builtin('process').map((name) => ({
      name,
      importNames: [...names],
      message: message[concern],
    }));
  const whole = (concern: Concern, ...names: readonly string[]) =>
    builtin(...names).map((name) => ({ name, message: message[concern] }));
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
      ...['getBuiltinModule', 'binding', 'dlopen'].map((property) => ({
        object: 'process',
        property,
        message: message.require,
      })),
      ...(forbid('stdout')
        ? [{ object: 'process', property: 'stdout', message: message.stdout }]
        : []),
      ...(forbid('stderr')
        ? ['stderr', 'emitWarning', '_rawDebug'].map((property) => ({
            object: 'process',
            property,
            message: message.stderr,
          }))
        : []),
    ],
    'no-restricted-imports': [
      'error',
      {
        paths: [
          ...whole('console', 'console'),
          ...processImports(['default'], 'process'),
          ...(forbid('stdout') ? processImports(['stdout'], 'stdout') : []),
          ...(forbid('stderr') ? processImports(['stderr'], 'stderr') : []),
          ...(forbid('stdout') ? whole('stdout', 'tty') : []),
          ...whole('require', 'module'),
          ...whole('subprocess', 'child_process', 'worker_threads', 'cluster'),
        ],
        patterns: forbid('mcp-sdk')
          ? [{ regex: '^@modelcontextprotocol/', message: message['mcp-sdk'] }]
          : [],
      },
    ],
    'no-restricted-syntax': [
      'error',
      { selector: importOf('console'), message: message.console },
      { selector: importOf('process'), message: message.process },
      { selector: importOf('module'), message: message.require },
      {
        selector: importOf('child_process|worker_threads|cluster'),
        message: message.subprocess,
      },
      {
        selector:
          "CallExpression[callee.type='Identifier'][callee.name='require']",
        message: message.require,
      },
      {
        // process or the global object as a value: anything but a property
        // read such as process.env or process['env'], and not a property
        // name or key that happens to read process.
        selector: [
          'Identifier[name=/^(process|globalThis|global)$/]:not(',
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
      ...(forbid('stdout')
        ? [
            ...writesTo(1, 'stdout'),
            { selector: importOf('tty'), message: message.stdout },
          ]
        : []),
      ...(forbid('stderr') ? writesTo(2, 'stderr') : []),
      ...(forbid('mcp-sdk')
        ? ['ImportExpression', 'TSImportType'].map((node) => ({
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
