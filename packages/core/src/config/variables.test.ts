import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { Secret } from '../http/index.js';
import { logLevels, redactionLevels } from '../logger/index.js';
import {
  defaultStdioSubject,
  environmentSchema,
  fitsVariable,
  nodeOptionsVariableName,
  type PlainVariableName,
  plainVariableNames,
  proxyVariableName,
  reservedStdioSubjects,
  stdioSubjectPattern,
  tlsKeylogOption,
  tlsTraceOption,
  tlsVariableName,
  tokenVariableName,
  trustStoreOptions,
  trustStoreVariableNames,
  unsupportedVariableNames,
  type Variable,
  variableNames,
  variablePrefix,
  variables,
  variableSchemas,
} from './variables.js';

const row = (name: string): Variable => {
  const found = variables.find((variable) => variable.name === name);
  if (found === undefined) throw new Error(`no row ${name}`);
  return found;
};

describe('the table of variables', () => {
  it('has one frozen row per name, in the order of the names', () => {
    expect(variables.map((variable) => variable.name)).toEqual([
      ...variableNames,
    ]);
    expect(Object.isFrozen(variables)).toBe(true);
    expect(Object.isFrozen(variableNames)).toBe(true);
    for (const variable of variables) {
      expect(Object.isFrozen(variable), variable.name).toBe(true);
      expect(Object.isFrozen(variable.choices), variable.name).toBe(true);
    }
  });

  it('gives every name the prefix, in capitals, and each name once', () => {
    const names = [
      ...variableNames,
      ...unsupportedVariableNames,
      proxyVariableName,
    ];
    for (const name of names) {
      expect(name.startsWith(variablePrefix), name).toBe(true);
      expect(name).toMatch(/^ECCLIUM_[A-Z0-9_]+$/);
    }
    expect(new Set(names).size).toBe(names.length);
    expect(Object.isFrozen(unsupportedVariableNames)).toBe(true);
  });

  it('names the variable that turns off the check of certificates', () => {
    expect(tlsVariableName).toBe('NODE_TLS_REJECT_UNAUTHORIZED');
  });

  // Node.js reads these names without the prefix, and they weaken TLS.
  it('names the settings of Node.js for TLS that the loader reads', () => {
    expect(nodeOptionsVariableName).toBe('NODE_OPTIONS');
    expect(trustStoreVariableNames).toEqual([
      'NODE_EXTRA_CA_CERTS',
      'NODE_USE_SYSTEM_CA',
      'SSL_CERT_FILE',
      'SSL_CERT_DIR',
    ]);
    expect(trustStoreOptions).toEqual(['--use-system-ca', '--use-openssl-ca']);
    expect(Object.isFrozen(trustStoreVariableNames)).toBe(true);
    expect(Object.isFrozen(trustStoreOptions)).toBe(true);
    expect([tlsKeylogOption, tlsTraceOption]).toEqual([
      '--tls-keylog',
      '--trace-tls',
    ]);
    for (const name of [nodeOptionsVariableName, ...trustStoreVariableNames]) {
      expect(name.startsWith(variablePrefix), name).toBe(false);
      expect(name).toMatch(/^[A-Z_]+$/);
    }
  });

  // The rows as the table in ADR 0055 lists them.
  it('holds the defaults, secrets and stdio rules of ADR 0055', () => {
    expect(
      variables.map(({ name, defaultValue, secret, stdioOnly }) => [
        name,
        defaultValue,
        secret,
        stdioOnly,
      ]),
    ).toEqual([
      ['ECCLIUM_CHURCHTOOLS_URL', undefined, false, false],
      ['ECCLIUM_CHURCHTOOLS_TOKEN_FILE', undefined, false, false],
      ['ECCLIUM_CHURCHTOOLS_TOKEN', undefined, true, true],
      ['ECCLIUM_CHURCHTOOLS_REQUESTS_PER_MINUTE', '300', false, false],
      ['ECCLIUM_READ_ONLY', 'true', false, false],
      ['ECCLIUM_REDACTION', 'standard', false, false],
      ['ECCLIUM_SEARCH_TOOLS', 'false', false, false],
      ['ECCLIUM_STATE_DIR', undefined, false, true],
      ['ECCLIUM_STDIO_SUBJECT', 'local-stdio', false, true],
      ['ECCLIUM_LOG_LEVEL', 'info', false, false],
    ]);
    expect(row('ECCLIUM_STDIO_SUBJECT').defaultValue).toBe(defaultStdioSubject);
  });

  it('marks only the token as a secret and keeps it from every schema', () => {
    expect(
      variables
        .filter((variable) => variable.secret)
        .map((variable) => variable.name),
    ).toEqual([tokenVariableName]);
    expect(row(tokenVariableName).kind).toBe('token');
    expect(plainVariableNames).toEqual(
      variableNames.filter((name) => name !== tokenVariableName),
    );
    expect(Object.isFrozen(plainVariableNames)).toBe(true);
    expect(Object.keys(variableSchemas)).toEqual([...plainVariableNames]);
    expect(Object.keys(environmentSchema.shape)).toEqual([
      ...plainVariableNames,
    ]);
  });

  it('lists the choices exactly, and only for booleans and choices', () => {
    expect(row('ECCLIUM_READ_ONLY').choices).toEqual(['true', 'false']);
    expect(row('ECCLIUM_SEARCH_TOOLS').choices).toEqual(['true', 'false']);
    expect(new Set(row('ECCLIUM_REDACTION').choices)).toEqual(
      new Set(redactionLevels),
    );
    expect(row('ECCLIUM_LOG_LEVEL').choices).toEqual([...logLevels]);
    for (const variable of variables) {
      expect(variable.choices.length > 0, variable.name).toBe(
        variable.kind === 'boolean' || variable.kind === 'choice',
      );
    }
  });

  it('lets every default and every choice fit its bound and its schema', () => {
    for (const variable of variables) {
      const values = [
        ...variable.choices,
        ...(variable.defaultValue === undefined ? [] : [variable.defaultValue]),
      ];
      for (const value of values) {
        expect(value.length).toBeLessThanOrEqual(variable.maxLength);
        expect(
          fitsVariable(variable.name as PlainVariableName, value),
          `${variable.name} ${value}`,
        ).toBe(true);
      }
    }
  });

  // The check of the address refuses its own codes up to this bound, so a
  // bound of the table above it keeps every code of the check reachable.
  it('bounds the address above the longest canonical address', () => {
    const longest = 'https://'.length + 253 + ':65535'.length + '/'.length;
    expect(row('ECCLIUM_CHURCHTOOLS_URL').maxLength).toBeGreaterThan(longest);
  });

  it('bounds the token at the longest value a Secret takes', () => {
    const { maxLength } = row(tokenVariableName);
    expect(() => new Secret('a'.repeat(maxLength))).not.toThrow();
    expect(() => new Secret('a'.repeat(maxLength + 1))).toThrow(RangeError);
  });
});

describe('the subject over stdio', () => {
  it('has a pattern without flags that its default fits', () => {
    expect(stdioSubjectPattern.flags).toBe('');
    expect(stdioSubjectPattern.test(defaultStdioSubject)).toBe(true);
  });

  // A reserved subject fits the pattern, so the loader must refuse it on
  // its own.
  it('reserves the placeholder of the audit, which fits the pattern', () => {
    expect(reservedStdioSubjects).toEqual(['invalid']);
    expect(Object.isFrozen(reservedStdioSubjects)).toBe(true);
    for (const subject of reservedStdioSubjects) {
      expect(fitsVariable('ECCLIUM_STDIO_SUBJECT', subject)).toBe(true);
    }
  });
});

describe('fitsVariable', () => {
  it.each([
    ['ECCLIUM_CHURCHTOOLS_URL', 'https://example.church.tools'],
    ['ECCLIUM_CHURCHTOOLS_URL', 'https://example.church.tools/'],
    ['ECCLIUM_CHURCHTOOLS_TOKEN_FILE', '/path/to/token-file'],
    ['ECCLIUM_READ_ONLY', 'false'],
    ['ECCLIUM_REDACTION', 'off'],
    ['ECCLIUM_SEARCH_TOOLS', 'true'],
    ['ECCLIUM_STATE_DIR', '/path/to/state'],
    ['ECCLIUM_STATE_DIR', '/'],
    ['ECCLIUM_STATE_DIR', `/${'a'.repeat(959)}`],
    ['ECCLIUM_STDIO_SUBJECT', 'a'],
    ['ECCLIUM_STDIO_SUBJECT', 'a'.repeat(32)],
    ['ECCLIUM_STDIO_SUBJECT', 'local-operator-2'],
    ['ECCLIUM_LOG_LEVEL', 'debug'],
  ] as const)('accept %s=%s', (name, value) => {
    expect(fitsVariable(name, value)).toBe(true);
  });

  it.each([
    ['ECCLIUM_CHURCHTOOLS_URL', ''],
    ['ECCLIUM_CHURCHTOOLS_URL', 'http://example.church.tools'],
    ['ECCLIUM_CHURCHTOOLS_URL', 'https://DEMO.example'],
    ['ECCLIUM_CHURCHTOOLS_URL', `https://${'a'.repeat(2048)}.example`],
    ['ECCLIUM_CHURCHTOOLS_TOKEN_FILE', ''],
    ['ECCLIUM_CHURCHTOOLS_TOKEN_FILE', 'token-file'],
    ['ECCLIUM_CHURCHTOOLS_TOKEN_FILE', './token-file'],
    ['ECCLIUM_CHURCHTOOLS_TOKEN_FILE', `/${'a'.repeat(4096)}`],
    ['ECCLIUM_READ_ONLY', ''],
    ['ECCLIUM_READ_ONLY', 'TRUE'],
    ['ECCLIUM_READ_ONLY', 'True'],
    ['ECCLIUM_READ_ONLY', ' true'],
    ['ECCLIUM_READ_ONLY', 'true '],
    ['ECCLIUM_READ_ONLY', '1'],
    ['ECCLIUM_READ_ONLY', 'yes'],
    ['ECCLIUM_SEARCH_TOOLS', 'False'],
    ['ECCLIUM_REDACTION', 'Standard'],
    ['ECCLIUM_REDACTION', 'none'],
    ['ECCLIUM_STATE_DIR', ''],
    ['ECCLIUM_STATE_DIR', 'state'],
    ['ECCLIUM_STATE_DIR', '~/state'],
    ['ECCLIUM_STATE_DIR', '/path/to/state/'],
    ['ECCLIUM_STATE_DIR', '/path//to/state'],
    ['ECCLIUM_STATE_DIR', '/path/./state'],
    ['ECCLIUM_STATE_DIR', '/path/../state'],
    ['ECCLIUM_STATE_DIR', `/${'a'.repeat(960)}`],
    ['ECCLIUM_STDIO_SUBJECT', ''],
    ['ECCLIUM_STDIO_SUBJECT', 'a'.repeat(33)],
    ['ECCLIUM_STDIO_SUBJECT', 'Local'],
    ['ECCLIUM_STDIO_SUBJECT', 'max.mustermann'],
    ['ECCLIUM_STDIO_SUBJECT', 'max.mustermann@example.org'],
    ['ECCLIUM_STDIO_SUBJECT', 'local stdio'],
    ['ECCLIUM_STDIO_SUBJECT', 'local_stdio'],
    ['ECCLIUM_STDIO_SUBJECT', '-local'],
    ['ECCLIUM_STDIO_SUBJECT', '1local'],
    ['ECCLIUM_STDIO_SUBJECT', 'local\n'],
    ['ECCLIUM_LOG_LEVEL', 'warning'],
    ['ECCLIUM_LOG_LEVEL', 'INFO'],
  ] as const)('refuse %s=%j', (name, value) => {
    expect(fitsVariable(name, value)).toBe(false);
  });

  // zod reads the length of any value it gets, also of one that is no
  // string, and so runs a getter or a trap of a proxy.
  // The error map of zod gets the input once anyone reads the error, so
  // fitsVariable never does.
  it('asks zod only whether a value fits, never for its error', () => {
    const spy = vi.fn(() => 'custom');
    try {
      z.config({ customError: spy });
      // The positive control: the spy fires once an error is read.
      expect(
        variableSchemas.ECCLIUM_READ_ONLY.safeParse('TRUE').error?.issues,
      ).toBeDefined();
      expect(spy).toHaveBeenCalled();
      spy.mockClear();
      const failing: [PlainVariableName, string][] = [
        ['ECCLIUM_CHURCHTOOLS_URL', 'http://demo.example'],
        ['ECCLIUM_CHURCHTOOLS_TOKEN_FILE', 'token-file'],
        ['ECCLIUM_CHURCHTOOLS_REQUESTS_PER_MINUTE', '0'],
        ['ECCLIUM_READ_ONLY', 'TRUE'],
        ['ECCLIUM_REDACTION', 'none'],
        ['ECCLIUM_SEARCH_TOOLS', 'yes'],
        ['ECCLIUM_STATE_DIR', 'state'],
        ['ECCLIUM_STDIO_SUBJECT', 'Max'],
        ['ECCLIUM_LOG_LEVEL', 'INFO'],
      ];
      expect(failing.map(([name]) => name)).toEqual([...plainVariableNames]);
      for (const [name, value] of failing) {
        expect(fitsVariable(name, value), name).toBe(false);
      }
      expect(spy).not.toHaveBeenCalled();
    } finally {
      z.config({ customError: undefined });
    }
  });

  it('refuse a value that is no string without asking zod', () => {
    const read: string[] = [];
    const value = Object.defineProperty({}, 'length', {
      get: () => {
        read.push('length');
        return 3;
      },
    }) as unknown as string;
    expect(fitsVariable('ECCLIUM_STDIO_SUBJECT', value)).toBe(false);
    expect(fitsVariable('ECCLIUM_CHURCHTOOLS_TOKEN_FILE', value)).toBe(false);
    expect(read).toEqual([]);
  });

  it.each([tokenVariableName, 'toString', 'ECCLIUM_TOOLSETS'])(
    'throw for %s, which has no schema',
    (name) => {
      expect(() => fitsVariable(name as PlainVariableName, 'value')).toThrow(
        'Only a variable without a secret has a schema.',
      );
    },
  );
});

describe('environmentSchema', () => {
  it('accepts no variable and every default', () => {
    expect(environmentSchema.safeParse({}).success).toBe(true);
    const defaults = Object.fromEntries(
      variables.flatMap((variable) =>
        variable.defaultValue === undefined
          ? []
          : [[variable.name, variable.defaultValue]],
      ),
    );
    expect(environmentSchema.safeParse(defaults).success).toBe(true);
  });

  it('refuses the token and any other unknown key', () => {
    expect(
      environmentSchema.safeParse({ [tokenVariableName]: 'value' }).success,
    ).toBe(false);
    expect(
      environmentSchema.safeParse({ ECCLIUM_TOOLSETS: 'read' }).success,
    ).toBe(false);
  });

  it('refuses a value that fails the schema of its variable', () => {
    expect(
      environmentSchema.safeParse({ ECCLIUM_READ_ONLY: 'TRUE' }).success,
    ).toBe(false);
  });
});
