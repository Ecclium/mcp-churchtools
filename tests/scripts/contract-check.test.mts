import { readFileSync, rmSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import { allowsNull, run, typeClass } from '../../scripts/contract/check.mts';
import { createState, instanceId } from '../../scripts/spike/lib/env.mts';
import {
  capture,
  origin,
  privateFiles,
  specification,
} from '../spike/support.mts';

// The check reads only contract.json and the state file of 00-inventory,
// here with the synthetic OpenAPI document of the spike tests.

const contract = readFileSync(
  new URL('../../packages/core/src/churchtools/contract.json', import.meta.url),
  'utf8',
);

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0))
    rmSync(folder, { recursive: true, force: true });
});

const withState = (document: unknown = specification) => {
  const files = privateFiles('unused');
  folders.push(files.folder);
  createState(files.stateFile, {
    format: 'ecclium-spike-state.v1',
    instance: instanceId(origin),
    version: '3.137',
    specification: document as never,
  });
  return {
    ECCLIUM_SPIKE_BASE_URL: origin,
    ECCLIUM_SPIKE_STATE_FILE: files.stateFile,
  };
};

describe('the contract check', () => {
  it('reports operations, parameters and fields as structure only', () => {
    const output = capture();
    expect(run(withState(), contract, output.io)).toBe(0);
    const result = JSON.parse(output.stdout()) as {
      churchtoolsVersion: string;
      operationen: {
        whoami: {
          dokumentiert: boolean;
          parameter: Record<string, boolean>;
          felder: { data: Record<string, { deklariert: boolean }> };
        };
        permissions: { dokumentiert: boolean; werteAlsMap: boolean };
      };
    };
    expect(result.churchtoolsVersion).toBe('3.137');
    expect(result.operationen.whoami.dokumentiert).toBe(true);
    expect(result.operationen.whoami.parameter).toEqual({
      only_allow_authenticated: true,
    });
    expect(Object.keys(result.operationen.whoami.felder.data)).toEqual([
      'id',
      'guid',
      'firstName',
      'lastName',
      'email',
    ]);
    expect(result.operationen.permissions).toMatchObject({
      dokumentiert: true,
      werteAlsMap: true,
    });
  });

  it('says not documented when the document lacks an operation', () => {
    const output = capture();
    const document = { ...specification, paths: {} };
    expect(run(withState(document), contract, output.io)).toBe(0);
    expect(output.stdout()).toContain('"dokumentiert": false');
  });

  it('refuses a missing state file without reading anything else', () => {
    const output = capture();
    expect(
      run({ ECCLIUM_SPIKE_BASE_URL: origin }, contract, output.io),
    ).not.toBe(0);
    expect(output.stdout()).toBe('');
  });

  it('refuses a contract that is no JSON', () => {
    const output = capture();
    expect(run(withState(), '{', output.io)).not.toBe(0);
  });

  it('names type classes and null with fixed words', () => {
    expect(typeClass(undefined)).toBe('unbekannt');
    expect(typeClass({ type: 'string' })).toBe('string');
    expect(typeClass({ type: ['string', 'null'] })).toBe('string');
    expect(typeClass({ type: ['string', 'integer'] })).toBe('mehrere');
    expect(typeClass({})).toBe('ohne Typ');
    expect(typeClass({ type: 'file' })).toBe('anderes');
    expect(allowsNull(undefined)).toBe(false);
    expect(allowsNull({ nullable: true })).toBe(true);
    expect(allowsNull({ type: ['string', 'null'] })).toBe(true);
    expect(allowsNull({ type: 'string' })).toBe(false);
  });
});
