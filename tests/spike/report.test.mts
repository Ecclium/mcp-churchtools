// The description of a response shows each distinct form of cookie
// attributes once, so the list does not give away how many cookies the
// instance set. Everything here is synthetic.
import { describe, expect, it } from 'vitest';

import { Guard } from '../../scripts/spike/lib/guard.mts';
import type { ProbeResponse } from '../../scripts/spike/lib/http.mts';
import { describeResponse } from '../../scripts/spike/lib/report.mts';
import { Schemas, asOpenApi } from '../../scripts/spike/lib/spec.mts';
import { specification } from './support.mts';

function cookiesOf(setCookies: readonly string[]): unknown {
  const document = asOpenApi(specification);
  if (document === undefined) {
    throw new Error('synthetic document is not accepted');
  }
  const response: ProbeResponse = {
    status: 200,
    headers: new Headers(),
    setCookies,
    body: undefined,
    kind: 'leer',
  };
  const description = describeResponse(response, {
    guard: new Guard(),
    schemas: new Schemas(document),
    operation: undefined,
  });
  return (description as Record<string, unknown>)['cookies'];
}

const sessionForm = {
  httpOnly: 'ja',
  secure: 'ja',
  sameSite: 'Lax',
  ablauf: 'Sitzung',
};

const session = (name: string): string =>
  `${name}=1; Path=/; Secure; HttpOnly; SameSite=Lax`;

describe('the description of cookies', () => {
  it('keeps one cookie as before', () => {
    expect(cookiesOf([session('a')])).toEqual({
      anzahl: '1',
      attribute: [sessionForm],
    });
  });

  it('shows two equal cookies as one form', () => {
    expect(cookiesOf([session('a'), session('b')])).toEqual({
      anzahl: '2–9',
      attribute: [sessionForm],
    });
  });

  it('shows two and three equal cookies alike', () => {
    expect(cookiesOf([session('a'), session('b'), session('c')])).toEqual(
      cookiesOf([session('a'), session('b')]),
    );
  });

  it('shows at most three forms and the class of the others', () => {
    const cookies = [
      session('a'),
      'b=1; Path=/; Secure; HttpOnly; SameSite=Strict',
      'c=1; Path=/; Secure; SameSite=None',
      'd=1; Path=/',
      'e=1; Path=/; Max-Age=60',
      session('f'),
    ];
    const result = cookiesOf(cookies) as Record<string, unknown>;
    expect(result['anzahl']).toBe('2–9');
    expect(result['attribute']).toHaveLength(3);
    expect(result['weitereFormen']).toBe('2–9');
  });
});
