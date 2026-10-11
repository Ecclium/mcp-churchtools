import type { Linter } from 'eslint';

import type { Boundaries, PlaceKey } from './boundaries.mts';
import { moduleStateRule } from './module-state-rule.mts';

// ESLint rules for the code of the packages, generated from boundaries.json
// and loaded by eslint.config.mjs. dependency-cruiser sees imports; these
// rules see what code does with them: writing to stdout or stderr, using
// console, loading modules past the import checks, starting processes,
// importing the MCP SDK, registering with it, opening network connections
// and keeping state at module level.
//
// Every restriction carries an id such as [arch:stdout] and its ADR in the
// message, so the tests can prove each one on its own. Several restrictions
// share an ESLint rule, and a later configuration block replaces the options
// of that rule as a whole. Each block therefore repeats every restriction it
// does not lift.
//
// The rules read code, not what it does at run time. The ADRs named in the
// messages list what they cannot see.

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
  'network',
  'mcp-register',
  'module-state',
] as const;

type Concern = (typeof concernIds)[number];

/** The ESLint rules that carry the restrictions. */
export const architectureRuleIds: readonly string[] = [
  'no-restricted-globals',
  'no-restricted-imports',
  'no-restricted-properties',
  'no-restricted-syntax',
  'ecclium-arch/no-module-state',
];

/**
 * Comments in a source file that would switch off an architecture rule: an
 * eslint-disable comment without a list of rules, one that names a rule of
 * architectureRuleIds, and an inline configuration of such a rule. ESLint
 * honours them, so a single comment would silence a whole restriction. A
 * comment that switches off another rule stays allowed.
 *
 * @param source - The text of a source file.
 * @returns The offending comments, empty when there are none.
 */
export function architectureDirectives(source: string): string[] {
  const found: string[] = [];
  const directive =
    /\/[*/]\s*(eslint(?:-disable(?:-next-line|-line)?)?)(?=[\s*]|$)([^\n]*)/g;
  for (const [whole, kind, rest = ''] of source.matchAll(directive)) {
    // The rules end at the end of a block comment or before a description
    // after two dashes.
    const text = (rest.split('*/')[0] ?? '').split('--')[0] ?? '';
    const names = text
      .split(',')
      .map((name) => name.trim().split(/[\s:]/)[0] ?? '')
      .filter((name) => name !== '');
    const blanket = kind !== 'eslint' && names.length === 0;
    if (blanket || names.some((name) => architectureRuleIds.includes(name))) {
      found.push(whole.trim());
    }
  }
  return found;
}

/** Concerns that some places may lift, and where boundaries.json lists them. */
const liftable: readonly (readonly [Concern, PlaceKey])[] = [
  ['stdout', 'stdout'],
  ['stderr', 'stderr'],
  ['mcp-sdk', 'mcpSdk'],
  ['network', 'egress'],
  ['mcp-register', 'mcpRegistration'],
];

/** The places of boundaries.json that lift a restriction. */
export const liftingPlaces: readonly PlaceKey[] = [
  ...new Set(liftable.map(([, key]) => key)),
];

const sources = '{ts,mts,cts}';

function messages(boundaries: Boundaries): Record<Concern, string> {
  const adr = (key: PlaceKey): string => `ADR ${boundaries.places[key].adr}`;
  return {
    console:
      '[arch:console] Code in the packages writes through the logger or the output module of the command line, never through console (ADR 0053).',
    stdout: `[arch:stdout] Only the output module of the command line writes to stdout. In the stdio mode stdout carries the MCP protocol (${adr('stdout')}).`,
    stderr: `[arch:stderr] Only the logger, the output module of the command line and the start of the elicitation spike in testkit write to stderr (${adr('stderr')}).`,
    process:
      '[arch:process] Use process and globalThis only through a property such as process.env. Passed on or taken apart, they hide writes to stdout and stderr from these rules (ADR 0053).',
    'mcp-sdk': `[arch:mcp-sdk] Only the mount in core, the server and the elicitation spike in testkit import the MCP SDK (${adr('mcpSdk')}).`,
    'dynamic-import':
      '[arch:dynamic-import] import() takes a fixed string, so that the architecture checks see what it loads (ADR 0022).',
    require:
      '[arch:require] Modules are loaded only with import, never through node:module, require or process.getBuiltinModule, which the architecture checks do not see (ADR 0022).',
    subprocess:
      '[arch:subprocess] The packages start no child processes, workers or cluster members, which can share stdout with the MCP protocol (ADR 0053).',
    'mcp-register': `[arch:mcp-register] Only the mount, and in testkit the server of the elicitation spike, register tools, prompts, resources and handlers with the MCP SDK, so that every call runs through the one pipeline (${adr('mcpRegistration')}).`,
    'module-state': `[arch:module-state] Code in the packages keeps no mutable state at module level. State that outlives a request is created in the composition root, as a named port or a named exception (${adr('moduleState')}).`,
    network: `[arch:network] Only the outbound path in core opens network connections, after it checks the host allow-list (${adr('egress')}).`,
  };
}

/**
 * Built-in modules that open or resolve network connections, or listen on a
 * port like the inspector. A fixed list: another library that opens
 * connections itself is a new dependency, which the review checks.
 */
const networkModules = [
  'http',
  'https',
  'http2',
  'net',
  'tls',
  'dgram',
  'dns',
  'dns/promises',
  'inspector',
  'inspector/promises',
] as const;

/**
 * Methods and properties of the MCP SDK that register tools, prompts,
 * resources or handlers, remove or announce them, or swap the handler of a
 * registered resource. The rule matches them by name, so the plugin API must
 * not use these names for its own methods. Checked against version 2.3.1 of
 * the SDK (ADR 0053).
 *
 * The objects that registerTool, registerPrompt and registerResource return
 * can also swap or switch off a handler: update({ callback }), remove(),
 * disable() and enabled on all of them, and the fields handler and executor,
 * which the SDK reads on every request. These names are too common for a
 * rule that matches names, so the mount keeps these objects to itself and
 * the review checks that.
 */
const registration =
  'registerTool|registerPrompt|registerResource|setRequestHandler|setNotificationHandler|fallbackRequestHandler|fallbackNotificationHandler|removeRequestHandler|removeNotificationHandler|registerCapabilities|readCallback';

/** Globals that open network connections. */
const networkGlobals = [
  'fetch',
  'WebSocket',
  'EventSource',
  'XMLHttpRequest',
] as const;

/** A module name with and without the prefix node:. */
const builtin = (...names: readonly string[]): string[] =>
  names.flatMap((name) => [`node:${name}`, name]);

/** A selector for import() or typeof import() of the given built-in modules. */
const importOf = (names: string, node = 'ImportExpression'): string =>
  `${node}[source.value=/^(node:)?(${names})$/]`;

/**
 * Selectors for a declaration of the given globals at module level. A
 * declaration for the type checker hides the global from ESLint, while the
 * code still calls the global at run time.
 */
const declarationsOf = (names: string): string[] => [
  `TSDeclareFunction[id.name=/^(${names})$/]`,
  `VariableDeclaration[declare=true] > VariableDeclarator[id.name=/^(${names})$/]`,
  `ClassDeclaration[declare=true][id.name=/^(${names})$/]`,
];

/**
 * The network modules as alternatives for a selector, which ends its regular
 * expression at the first slash.
 */
const networkNames = networkModules
  .map((name) => name.replace('/', String.raw`\x2F`))
  .join('|');

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
      ...(forbid('network')
        ? networkGlobals.map((name) => ({ name, message: message.network }))
        : []),
    ],
    'no-restricted-properties': [
      'error',
      ...['globalThis', 'global'].flatMap((object) => [
        { object, property: 'console', message: message.console },
        { object, property: 'process', message: message.process },
        ...(forbid('network')
          ? networkGlobals.map((property) => ({
              object,
              property,
              message: message.network,
            }))
          : []),
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
          ...(forbid('network') ? whole('network', ...networkModules) : []),
        ],
        patterns: [
          ...(forbid('mcp-sdk')
            ? [
                {
                  regex: '^@modelcontextprotocol/',
                  message: message['mcp-sdk'],
                },
              ]
            : []),
          ...(forbid('network')
            ? [{ regex: '^undici(/|$)', message: message.network }]
            : []),
        ],
      },
    ],
    'no-restricted-syntax': [
      'error',
      { selector: importOf('console'), message: message.console },
      ...declarationsOf('console').map((selector) => ({
        selector,
        message: message.console,
      })),
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
      ...(forbid('mcp-register')
        ? [
            // Any access, not only a call: a method passed on or bound
            // registers just as well, and so does an assignment to a
            // fallback handler. A key built from a variable or by
            // concatenation is not seen.
            `MemberExpression[property.name=/^(${registration})$/]`,
            `MemberExpression[property.value=/^(${registration})$/]`,
            `MemberExpression[property.type='TemplateLiteral'][property.quasis.0.value.cooked=/^(${registration})$/]`,
            `ObjectPattern > Property[key.name=/^(${registration})$/]`,
            `ObjectPattern > Property[key.value=/^(${registration})$/]`,
          ].map((selector) => ({ selector, message: message['mcp-register'] }))
        : []),
      ...(forbid('network')
        ? declarationsOf(networkGlobals.join('|')).map((selector) => ({
            selector,
            message: message.network,
          }))
        : []),
      ...(forbid('network')
        ? ['ImportExpression', 'TSImportType'].flatMap((node) => [
            {
              selector: importOf(networkNames, node),
              message: message.network,
            },
            {
              selector: String.raw`${node}[source.value=/^undici(\x2F|$)/]`,
              message: message.network,
            },
          ])
        : []),
    ],
  };
}

/**
 * Builds the configuration blocks: one for all code in the packages, then
 * one for each place that lifts a restriction. Longer paths come later, so
 * a place inside another one wins and keeps what the outer place allows.
 * The rule against state at module level has its own block, because it is
 * not one of the shared ESLint rules; tests and the files of moduleState are
 * exempt from it.
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
    {
      name: 'architecture: module state',
      files: [`packages/*/src/**/*.${sources}`],
      ignores: [
        // Only the form that Vitest runs and the build leaves out: a file
        // that ships is never treated as a test.
        'packages/*/src/**/*.test.ts',
        ...boundaries.places.moduleState.paths,
      ],
      plugins: {
        'ecclium-arch': { rules: { 'no-module-state': moduleStateRule } },
      },
      rules: {
        'ecclium-arch/no-module-state': [
          'error',
          { message: message['module-state'] },
        ],
      },
    },
  ];
}
