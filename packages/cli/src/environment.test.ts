import { tokenVariableName } from '@ecclium/mcp-churchtools-core';
import { makeCanary } from '@ecclium/mcp-churchtools-testkit';
import { describe, expect, it } from 'vitest';

import { takeEnvironment } from './environment.js';

type Environment = Record<string, string | undefined>;

describe('takeEnvironment', () => {
  it('copies the variables and removes the token from the environment', () => {
    const token = makeCanary('token').value;
    const environment: Environment = {
      ECCLIUM_CHURCHTOOLS_URL: 'https://example.church.tools',
      [tokenVariableName]: token,
      HOME: '/home/demo',
    };
    const copy = takeEnvironment(environment, [tokenVariableName]);
    expect({ ...copy }).toEqual({
      ECCLIUM_CHURCHTOOLS_URL: 'https://example.church.tools',
      [tokenVariableName]: token,
      HOME: '/home/demo',
    });
    expect(Object.keys(environment)).toEqual([
      'ECCLIUM_CHURCHTOOLS_URL',
      'HOME',
    ]);
  });

  it('removes the token in every spelling of its name', () => {
    const lower = tokenVariableName.toLowerCase();
    const mixed = `${tokenVariableName.slice(0, 8)}${lower.slice(8)}`;
    const environment: Environment = {
      [lower]: makeCanary('token').value,
      [mixed]: makeCanary('token').value,
      [`${tokenVariableName}_FILE`]: '/path/to/token-file',
    };
    const copy = takeEnvironment(environment, [tokenVariableName]);
    expect(Object.keys(environment)).toEqual([`${tokenVariableName}_FILE`]);
    expect(Object.keys(copy)).toEqual([
      lower,
      mixed,
      `${tokenVariableName}_FILE`,
    ]);
  });

  it('compares names in ASCII only', () => {
    // A dotless i in capitals would match with toUpperCase.
    const lookalike = tokenVariableName.replace('I', '\u0131');
    const environment: Environment = { [lookalike]: 'kept' };
    takeEnvironment(environment, [tokenVariableName]);
    expect(Object.keys(environment)).toEqual([lookalike]);
  });

  it('gives a frozen copy without a prototype', () => {
    const copy = takeEnvironment({ A: 'a' }, []);
    expect(Object.isFrozen(copy)).toBe(true);
    expect(Object.getPrototypeOf(copy)).toBeNull();
  });

  it('copies own strings only', () => {
    const environment = Object.create({ INHERITED: 'x' }) as Environment;
    environment.PLAIN = 'plain';
    environment.UNSET = undefined;
    expect({ ...takeEnvironment(environment, []) }).toEqual({ PLAIN: 'plain' });
  });

  it('refuses a getter without running it and removes nothing', () => {
    const reads: string[] = [];
    const environment: Environment = { [tokenVariableName]: 'kept' };
    Object.defineProperty(environment, 'GETTER', {
      enumerable: true,
      get: () => {
        reads.push('GETTER');
        return 'value';
      },
    });
    expect(() => takeEnvironment(environment, [tokenVariableName])).toThrow(
      new TypeError('The environment cannot be taken over.'),
    );
    expect(reads).toEqual([]);
    expect(Object.keys(environment)).toEqual([tokenVariableName, 'GETTER']);
  });

  it('refuses a value that is no string and removes nothing', () => {
    const environment: Environment = { [tokenVariableName]: 'kept' };
    Object.defineProperty(environment, 'NUMBER', {
      enumerable: true,
      value: 42,
    });
    expect(() => takeEnvironment(environment, [tokenVariableName])).toThrow(
      new TypeError('The environment cannot be taken over.'),
    );
    expect(Object.keys(environment)).toEqual([tokenVariableName, 'NUMBER']);
  });

  it('leaves the environment alone without secret names', () => {
    const environment: Environment = { [tokenVariableName]: 'kept' };
    takeEnvironment(environment, []);
    expect(Object.keys(environment)).toEqual([tokenVariableName]);
  });

  it.each([
    ['no object', 'environment', []],
    ['null', null, []],
    ['a proxy', new Proxy({}, {}), []],
    ['names that are no list', {}, 'NAME'],
    ['names in a proxy', {}, new Proxy([], {})],
  ])('refuses %s', (_, environment, names) => {
    expect(() =>
      takeEnvironment(
        environment as unknown as Environment,
        names as unknown as string[],
      ),
    ).toThrow(new TypeError('The environment cannot be taken over.'));
  });
});
