import {
  type ConfigProblem,
  type ConfigProblemCode,
  configProblemCodes,
  type ConfigWarningCode,
  configWarningCodes,
  loadConfig,
  proxyVariableName,
  tlsVariableName,
  tokenVariableName,
  unsupportedVariableNames,
  variableNames,
  variables,
} from '@ecclium/mcp-churchtools-core';
import { assertNoCanary, makeCanary } from '@ecclium/mcp-churchtools-testkit';
import { describe, expect, it } from 'vitest';

import {
  formatNumber,
  type Message,
  type MessageText,
  problemMessage,
  problemText,
  warningMessage,
  warningText,
} from './index.js';

// The three parts as the catalog joins them.
const textOf = (message: Message): string =>
  `${message.what} ${message.why} ${message.action}`;

// The variable each problem code is reported with by the loader, so every
// message is checked in the form an operator sees it.
const variableOf = (code: ConfigProblemCode): string => {
  if (code.startsWith('url_')) return 'ECCLIUM_CHURCHTOOLS_URL';
  if (code.startsWith('token_file_') || code === 'token_missing') {
    return 'ECCLIUM_CHURCHTOOLS_TOKEN_FILE';
  }
  switch (code) {
    case 'token_conflict':
    case 'token_invalid':
      return 'ECCLIUM_CHURCHTOOLS_TOKEN';
    case 'proxy_unsupported':
      return 'ECCLIUM_EGRESS_PROXY';
    case 'unsupported_variable':
      return 'ECCLIUM_TOOLSETS';
    case 'tls_check_disabled':
      return 'NODE_TLS_REJECT_UNAUTHORIZED';
    case 'debug_output_enabled':
      return 'NODE_DEBUG';
    case 'tls_keylog_enabled':
    case 'tls_trace_enabled':
      return 'NODE_OPTIONS';
    case 'redaction_strict_unsupported':
    case 'stdio_only':
      return 'ECCLIUM_REDACTION';
    case 'subject_invalid':
    case 'subject_reserved':
      return 'ECCLIUM_STDIO_SUBJECT';
    case 'unknown_variable':
      return 'ECCLIUM_REDONLY';
    default:
      return 'ECCLIUM_READ_ONLY';
  }
};

// Every name the loader can report with a problem: the known variables,
// the names of later phases and of a proxy, the variable of TLS, the
// variable with the options of Node.js and the longest unknown name it
// shows.
const reportedNames: readonly string[] = [
  ...variableNames,
  ...unsupportedVariableNames,
  proxyVariableName,
  tlsVariableName,
  'NODE_OPTIONS',
  `ECCLIUM_${'A'.repeat(64)}`,
];

/** Every message of the catalog, with a label for the report. */
const everyMessage: [string, Message][] = [
  ...configProblemCodes.flatMap((code) =>
    reportedNames.map((name): [string, Message] => [
      `${code} with ${name.slice(0, 40)}`,
      problemMessage({ code, variable: name }),
    ]),
  ),
  ...configProblemCodes.map((code): [string, Message] => [
    `${code} without a name`,
    problemMessage({ code }),
  ]),
  ...configWarningCodes.map((code): [string, Message] => [
    code,
    warningMessage(code),
  ]),
];

const hasControlCharacter = (text: string): boolean => {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
};

describe('the catalog of messages', () => {
  it.each(everyMessage)(
    'says what, why and what to do for %s',
    (_, message) => {
      expect(Object.keys(message)).toEqual(['what', 'why', 'action']);
      expect(Object.isFrozen(message)).toBe(true);
      for (const part of [message.what, message.why, message.action]) {
        expect(part.length).toBeGreaterThan(10);
        expect(part).toMatch(/^[A-ZÄÖÜ‹«]/);
        expect(part).toMatch(/\.$/);
        expect(part).not.toMatch(/\s{2}|^\s|\s$/);
      }
    },
  );

  // Chapter 9 of brand/README.md: «Sie», ss, quotes «so», no em dash, no
  // exclamation mark, numbers from 1000 up as 4'096, none of the words it
  // lists.
  it.each(everyMessage)(
    'follows the rules of the brand in %s',
    (_, message) => {
      const text = textOf(message);
      expect(text.replace(/(?<=\d)'(?=\d{3})/g, '')).not.toMatch(
        /[ß—–!"„“”'‚‘’\u00a0]/,
      );
      expect(text).not.toMatch(/\d{4}/);
      expect(hasControlCharacter(text)).toBe(false);
      expect(text.split('«').length).toBe(text.split('»').length);
      expect(text.split('‹').length).toBe(text.split('›').length);
      expect(text).not.toMatch(/\b(du|dein|deine|dich|dir)\b/i);
      expect(text).not.toMatch(
        /revolutionär|nahtlos|einzigartig|smart|magisch|mühelos|einfach|100 % sicher/i,
      );
    },
  );

  it('asks for a new key in the key file and for the one in use so far in the file of the previous key', () => {
    for (const code of [
      'pseudonym_key_invalid',
      'pseudonym_key_file_empty',
    ] as const) {
      const current = problemText({
        code,
        variable: 'ECCLIUM_PSEUDONYM_KEY_FILE',
      });
      const previous = problemText({
        code,
        variable: 'ECCLIUM_PSEUDONYM_KEY_PREVIOUS_FILE',
      });
      expect(current).toContain('‹ECCLIUM_PSEUDONYM_KEY_FILE›');
      expect(current).toContain('‹openssl rand -hex 32›');
      expect(current).not.toContain('bisherigen');
      expect(previous).toContain('‹ECCLIUM_PSEUDONYM_KEY_PREVIOUS_FILE›');
      expect(previous).toContain('den bisherigen Schlüssel unverändert');
      expect(previous).not.toContain('openssl');
    }
  });

  it('names the variable it was given, in ‹›', () => {
    expect(
      problemText({ code: 'empty_value', variable: 'ECCLIUM_READ_ONLY' }),
    ).toContain('‹ECCLIUM_READ_ONLY›');
    expect(
      problemText({ code: 'unknown_variable', variable: 'ECCLIUM_REDONLY' }),
    ).toContain('‹ECCLIUM_REDONLY›');
  });

  it.each([
    ['a name in small letters', 'ECCLIUM_read_only'],
    ['a name with a value', 'ECCLIUM_READ_ONLY=false'],
    ['a name with a space', 'ECCLIUM_READ ONLY'],
    ['a name of 65 characters after the prefix', `ECCLIUM_${'A'.repeat(65)}`],
    ['a variable of Node.js reported only by a warning', 'NODE_EXTRA_CA_CERTS'],
    ['a name with something before the prefix', 'x_ECCLIUM_READ_ONLY'],
    [
      'the variable of TLS with more after it',
      'NODE_TLS_REJECT_UNAUTHORIZED_X',
    ],
    ['the variable of TLS with a value', 'NODE_TLS_REJECT_UNAUTHORIZED=0'],
    ['the debug variable with a value', 'NODE_DEBUG=stream'],
    ['the debug variable in small letters', 'node_debug'],
    [
      'the variable of TLS with something before it',
      'x_NODE_TLS_REJECT_UNAUTHORIZED',
    ],
  ])('leaves out %s', (_, variable) => {
    for (const code of configProblemCodes) {
      expect(problemText({ code, variable })).not.toContain(variable);
    }
  });

  it('never shows a canary given as the name of a variable', () => {
    const canary = makeCanary('token').value;
    for (const code of configProblemCodes) {
      expect(
        problemText({ code, variable: `ECCLIUM_${canary}` }),
      ).not.toContain(canary);
    }
  });

  // The listed values follow the loader: a value of the table that this
  // version refuses, such as strict, is never offered.
  it.each(variables.filter((variable) => variable.choices.length > 0))(
    'lists the values the loader takes for $name',
    (variable) => {
      const text = problemText({
        code: 'invalid_choice',
        variable: variable.name,
      });
      for (const choice of variable.choices) {
        const result = loadConfig({
          environment: {
            ECCLIUM_CHURCHTOOLS_URL: 'https://example.church.tools',
            [tokenVariableName]: makeCanary('token').value,
            [variable.name]: choice,
          },
          transport: 'stdio',
        });
        const refused = result.report.problems.some(
          (problem) => problem.variable === variable.name,
        );
        expect(text.includes(`‹${choice}›`), choice).toBe(!refused);
      }
    },
  );

  it('says that off is only for stdio, as the loader refuses it over HTTP', () => {
    const result = loadConfig({
      environment: { ECCLIUM_REDACTION: 'off' },
      transport: 'http',
    });
    expect(result.report.problems).toContainEqual({
      code: 'stdio_only',
      variable: 'ECCLIUM_REDACTION',
    });
    expect(
      problemText({ code: 'invalid_choice', variable: 'ECCLIUM_REDACTION' }),
    ).toContain('‹off› nur im Betrieb über stdio');
  });

  it.each(variableNames)('names the longest value of %s', (name) => {
    const longest = variables.find(
      (variable) => variable.name === name,
    )?.maxLength;
    // An address passes only as a canonical origin of at most 268
    // characters, far below the bound of the table.
    expect(problemText({ code: 'value_too_long', variable: name })).toContain(
      name === 'ECCLIUM_CHURCHTOOLS_URL'
        ? 'höchstens 268 Zeichen'
        : `höchstens ${formatNumber(longest ?? -1)} Zeichen`,
    );
  });

  // Only ECCLIUM_REDACTION is refused for one value over HTTP; the others
  // are refused with any value, and the token must leave the environment.
  it.each([
    ['ECCLIUM_REDACTION', 'mit diesem Wert', 'auf ihre Voreinstellung'],
    [
      'ECCLIUM_CHURCHTOOLS_TOKEN',
      'ist nur im Betrieb über stdio erlaubt.',
      'Entfernen Sie ‹ECCLIUM_CHURCHTOOLS_TOKEN› und nennen Sie in ‹ECCLIUM_CHURCHTOOLS_TOKEN_FILE›',
    ],
    [
      'ECCLIUM_STDIO_SUBJECT',
      'gilt nur im Betrieb über stdio.',
      'Entfernen Sie die Variable für den Betrieb über HTTP.',
    ],
  ])(
    'gives %s a fitting text when it is only for stdio',
    (name, what, action) => {
      const message = problemMessage({ code: 'stdio_only', variable: name });
      expect(message.what).toContain(`‹${name}›`);
      expect(message.what).toContain(what);
      expect(message.action).toContain(action);
      if (name !== 'ECCLIUM_REDACTION') {
        expect(textOf(message)).not.toMatch(/mit diesem Wert|Voreinstellung/);
      }
    },
  );

  // A name with letters beyond ASCII never reaches url_host: the parser
  // turns it into Punycode, so the address is not in its canonical form.
  it.each([
    ['umlauts', 'https://b\u00fccher.example'],
    ['an accent', 'https://\u00e9glise.example'],
  ])(
    'tells how to write a name with %s, as the loader reports it',
    (_, url) => {
      const result = loadConfig({
        environment: { ECCLIUM_CHURCHTOOLS_URL: url },
        transport: 'stdio',
      });
      const problem = result.report.problems.find(
        (entry) => entry.variable === 'ECCLIUM_CHURCHTOOLS_URL',
      );
      expect(problem?.code).toBe('url_not_canonical');
      const text = problemText(problem ?? { code: 'url_missing' });
      expect(text).toContain('ausserhalb von ASCII');
      expect(text).toContain('internationalen Namen als Punycode');
    },
  );

  it('warns that other programs of the user can read the token', () => {
    const text = warningText('token_from_environment');
    expect(text).toContain('andere Programme Ihres Benutzers');
    expect(text).not.toMatch(/Kindprozess|startet, sähe/);
  });

  // The notice on every start with the toolset persons names what the AI
  // assistant then sees (ADR 0060).
  it('names the toolset persons and what the AI assistant sees with it', () => {
    const message = warningMessage('persons_toolset_enabled');
    expect(message.what).toContain('‹persons›');
    expect(message.why).toContain('Kennung und Name jedes Treffers');
    expect(message.why).toContain('Namen ihrer Mitglieder');
    expect(message.why).toContain('Kontaktdaten liest er nicht');
    expect(message.why).toContain('Audit-Datei');
    expect(message.action).toContain('‹ECCLIUM_TOOLSETS›');
    expect(textOf(message)).not.toMatch(/späteren Version|wirkt .*nicht/);
  });

  // The notice on every start with the toolset events names the persons in
  // the assignments to services (ADR 0064).
  it('names the toolset events and the persons assigned to services', () => {
    const message = warningMessage('events_toolset_enabled');
    expect(message.what).toContain('‹events›');
    expect(message.why).toContain('eingeteilt');
    expect(message.why).toContain('Namen verbergen');
    expect(message.why).toContain('Kontaktdaten liest er nicht');
    expect(message.why).toContain('Audit-Datei');
    expect(message.action).toContain('‹ECCLIUM_TOOLSETS›');
  });

  // The escape hatch passes on whole answers; the warning says what stays
  // unmasked (ADR 0067).
  it('names the toolset api and what its answers keep unmasked', () => {
    const message = warningMessage('api_toolset_enabled');
    expect(message.what).toBe('Das Toolset ‹api› ist eingeschaltet.');
    expect(message.why).toContain('ganze Antwort');
    expect(message.why).toContain('Adressen, Notizen und andere Angaben nicht');
    expect(message.why).toContain('Audit-Datei');
    expect(message.why).toContain('Lesebudget');
    expect(message.action).toContain('‹api› aus ‹ECCLIUM_TOOLSETS›');
  });

  it('asks for the folder of the audit file when persons, events or api is on', () => {
    const message = problemMessage({
      code: 'toolsets_without_state_dir',
      variable: 'ECCLIUM_STATE_DIR',
    });
    expect(message.what).toContain('‹persons›, ‹events› oder ‹api›');
    expect(message.why).toContain('ganze Antworten');
    expect(message.action).toContain('‹persons›, ‹events› und ‹api›');
    expect(message.what).toContain('‹ECCLIUM_TOOLSETS›');
    expect(message.what).toContain('‹ECCLIUM_STATE_DIR› ist nicht gesetzt');
    expect(message.why).toContain('Unter Windows');
    expect(message.action).toContain('Rechten 700');
  });

  it('points from the replaced switch to the toolset persons', () => {
    const message = problemMessage({
      code: 'search_tools_replaced',
      variable: 'ECCLIUM_SEARCH_TOOLS',
    });
    expect(message.what).toContain('‹ECCLIUM_SEARCH_TOOLS› gibt es nicht mehr');
    expect(message.why).toContain('‹ECCLIUM_TOOLSETS›');
    expect(message.action).toContain('‹ECCLIUM_TOOLSETS=persons›');
  });

  it('names every toolset and all for a list that is not allowed', () => {
    const message = problemMessage({
      code: 'invalid_toolsets',
      variable: 'ECCLIUM_TOOLSETS',
    });
    expect(message.why).toContain(
      '‹persons›, ‹events›, ‹calendars›, ‹wiki›, ‹songs›, ‹docs› und ‹api›',
    );
    expect(message.why).toContain('‹all› allein für alle ausser ‹api›');
    expect(message.why).toContain('‹all,api› für alle');
    expect(message.why).toContain('ohne Leerzeichen');
  });

  // One warning stands for every setting that extends the trust store, as
  // the report of the loader names none of them.
  it('names every setting that extends the trust store in its warning', () => {
    const text = warningText('trust_store_extended');
    for (const name of [
      'NODE_EXTRA_CA_CERTS',
      'NODE_USE_SYSTEM_CA',
      'SSL_CERT_FILE',
      'SSL_CERT_DIR',
      '--use-system-ca',
      '--use-openssl-ca',
    ]) {
      expect(text).toContain(`‹${name}›`);
    }
    expect(text).toContain('das Token mitlesen');
  });

  it.each([
    ['tls_keylog_enabled', '--tls-keylog'],
    ['tls_trace_enabled', '--trace-tls'],
  ] as const)('tells for %s where the option was found', (code, option) => {
    const inVariable = problemMessage({ code, variable: 'NODE_OPTIONS' });
    expect(inVariable.what).toBe(
      `Die Option ‹${option}› steht in ‹NODE_OPTIONS›.`,
    );
    expect(inVariable.action).toContain('aus ‹NODE_OPTIONS›');
    const started = problemMessage({ code });
    expect(started.what).toBe(`Node.js läuft mit der Option ‹${option}›.`);
    expect(started.action).toContain('aus dem Befehl');
    expect(textOf(started)).not.toContain('NODE_OPTIONS');
  });

  // The loader reads the paths of certificates and of a key log, but its
  // report, and so every text, holds only codes and names.
  it('never shows the path of a certificate or of a key log', () => {
    const canary = makeCanary('token');
    const path = `/path/${canary.value}`;
    const result = loadConfig({
      environment: {
        ECCLIUM_CHURCHTOOLS_URL: 'https://example.church.tools',
        [tokenVariableName]: makeCanary('token').value,
        NODE_EXTRA_CA_CERTS: `${path}/ca.pem`,
        SSL_CERT_FILE: `${path}/cert.pem`,
        SSL_CERT_DIR: path,
        NODE_OPTIONS: `--tls-keylog=${path}/keys`,
      },
      transport: 'stdio',
      execArgv: ['--tls-keylog', `${path}/keys`, '--trace-tls'],
    });
    const texts = [
      ...result.report.problems.map((problem) => problemText(problem)),
      ...result.report.warnings.map((code) => warningText(code)),
    ];
    expect(texts).toEqual([
      problemText({ code: 'tls_keylog_enabled' }),
      problemText({ code: 'tls_keylog_enabled', variable: 'NODE_OPTIONS' }),
      problemText({ code: 'tls_trace_enabled' }),
      warningText('token_from_environment'),
      warningText('trust_store_extended'),
    ]);
    assertNoCanary(texts, [canary], 'texts');
  });

  it('tells the token in the environment from the one in the file', () => {
    const fromEnvironment = problemMessage({
      code: 'token_invalid',
      variable: 'ECCLIUM_CHURCHTOOLS_TOKEN',
    });
    const fromFile = problemMessage({
      code: 'token_invalid',
      variable: 'ECCLIUM_CHURCHTOOLS_TOKEN_FILE',
    });
    expect(fromEnvironment.what).toContain('‹ECCLIUM_CHURCHTOOLS_TOKEN›');
    expect(fromFile.what).toContain('Token-Datei');
  });

  it('joins the three parts with one space each', () => {
    for (const code of configProblemCodes) {
      const problem = { code, variable: variableOf(code) };
      expect(problemText(problem)).toBe(textOf(problemMessage(problem)));
    }
    for (const code of configWarningCodes) {
      expect(warningText(code)).toBe(textOf(warningMessage(code)));
    }
  });

  // The start notices take only texts of the catalog. A function that made
  // one from any three strings would open them to free text.
  it('exports no function that makes a text from free text', async () => {
    const exported = [
      'formatNumber',
      'problemMessage',
      'problemText',
      'warningMessage',
      'warningText',
    ];
    expect(Object.keys(await import('./config.js')).sort()).toEqual(exported);
    // The texts of the start over stdio come from their own module, which
    // its test checks the same way.
    expect(Object.keys(await import('./index.js')).sort()).toEqual(
      [
        ...exported,
        'auditFileMessage',
        'auditFileText',
        'emptyToolsetMessage',
        'emptyToolsetText',
        'quotaFolderMessage',
        'quotaFolderText',
        'refusalMessage',
        'refusalText',
        'startMessage',
        'startText',
        'toolsetsMessage',
        'toolsetsText',
      ].sort(),
    );
    // @ts-expect-error A plain string is no text of the catalog.
    const forged: MessageText = 'Freier Text.';
    expect(forged).toBe('Freier Text.');
  });

  it('refuses a code that is none of the catalog, such as toString', () => {
    const problem: ConfigProblem = { code: 'toString' as ConfigProblemCode };
    expect(() => problemMessage(problem)).toThrow(
      'The problem code is unknown.',
    );
  });

  it('refuses a warning that is none of the catalog, such as toString', () => {
    expect(() => warningText('toString' as ConfigWarningCode)).toThrow(
      new TypeError('The warning code is unknown.'),
    );
  });

  // A getter could give a checked name on the first read and free text on
  // the next, so the fields are read once, as own data properties.
  it('runs no getter of a problem and shows no text it would give', () => {
    const reads: string[] = [];
    const problem = {
      code: 'unknown_variable',
      get variable(): string {
        reads.push('variable');
        return reads.length < 3 ? 'ECCLIUM_X' : 'Freier Text';
      },
    } as ConfigProblem;
    const text = problemText(problem);
    expect(reads).toEqual([]);
    expect(text).not.toContain('Freier Text');
    expect(text).not.toContain('ECCLIUM_X');
  });

  it.each([
    [
      'a code behind a getter',
      Object.defineProperty({}, 'code', { get: () => 'url_missing' }),
    ],
    ['a proxy', new Proxy({ code: 'url_missing' }, {})],
    ['no object', 'url_missing'],
  ])('refuses %s as a problem', (_, problem) => {
    expect(() => problemText(problem as unknown as ConfigProblem)).toThrow(
      new TypeError('The problem code is unknown.'),
    );
  });
});

describe('formatNumber', () => {
  it.each([
    [0, '0'],
    [7, '7'],
    [268, '268'],
    [999, '999'],
    [1000, "1'000"],
    [4096, "4'096"],
    [65536, "65'536"],
    [1234567, "1'234'567"],
  ])('writes %i as %s', (value, text) => {
    expect(formatNumber(value)).toBe(text);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])(
    'refuses %s',
    (value) => {
      expect(() => formatNumber(value)).toThrow(
        new TypeError('The number cannot be formatted.'),
      );
    },
  );
});
