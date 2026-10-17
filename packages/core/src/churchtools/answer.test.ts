import {
  assertNoCanary,
  assertPlanted,
  makeCanaries,
} from '@ecclium/mcp-churchtools-testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HttpResponse } from '../http/index.js';
import { readAnswer } from './answer.js';

// The answers are built by hand, as the transport would give them. Hosts and
// values are invented; canaries are made at run time.

const encoder = new TextEncoder();
const canaries = makeCanaries();

const answer = (
  status: number,
  body: string | Uint8Array,
  headers: Record<string, string> = { 'content-type': 'application/json' },
): HttpResponse =>
  Object.freeze({
    status,
    headers: Object.freeze({ ...headers }),
    body: typeof body === 'string' ? encoder.encode(body) : body,
  });

const limits = { maxElements: 100 };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('readAnswer', () => {
  it('parses a JSON object with status 200, frozen and without prototype', () => {
    const read = readAnswer(answer(200, '{"data":{"id":1}}'), limits);
    expect(read).toEqual({ ok: true, root: { data: { id: 1 } } });
    expect(Object.isFrozen(read)).toBe(true);
    expect(Object.getPrototypeOf(read)).toBeNull();
  });

  it('maps each status once', () => {
    const codes: Record<string, string> = {};
    for (let status = 200; status <= 599; status += 1) {
      if (status >= 300 && status < 400) continue;
      const read = readAnswer(answer(status, '{}'), limits);
      if (!read.ok)
        codes[read.code] = (codes[read.code] ?? '') + `${String(status)} `;
    }
    expect(codes.auth).toBe('401 ');
    expect(codes.permission).toBe('403 ');
    expect(codes.rate_limited).toBe('429 ');
    expect(codes.internal).toBe('400 ');
    expect(codes.upstream?.split(' ').filter(Boolean)).toHaveLength(
      99 + 200 - 4,
    );
    expect(readAnswer(answer(302, '{}'), limits)).toMatchObject({
      ok: false,
      code: 'upstream',
      reason: 'status',
    });
  });

  it('gives the wait of a 429 in whole seconds only', () => {
    expect(
      readAnswer(answer(429, '', { 'retry-after': '120' }), limits),
    ).toEqual({
      ok: false,
      code: 'rate_limited',
      reason: 'status',
      waitSeconds: 120,
    });
    expect(
      readAnswer(
        answer(429, '', { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' }),
        limits,
      ),
    ).toEqual({
      ok: false,
      code: 'rate_limited',
      reason: 'status',
    });
    expect(
      readAnswer(answer(503, '', { 'retry-after': '120' }), limits),
    ).toEqual({
      ok: false,
      code: 'upstream',
      reason: 'status',
    });
  });

  it.each([
    'application/json',
    'application/json; charset=utf-8',
    'APPLICATION/JSON',
    '  application/json ;x=1',
  ])('takes the media type %j', (type) => {
    expect(
      readAnswer(answer(200, '{}', { 'content-type': type }), limits).ok,
    ).toBe(true);
  });

  it.each([['text/html'], ['application/jsonx'], ['application/problem+json']])(
    'refuses the media type %j',
    (type) => {
      expect(
        readAnswer(answer(200, '{}', { 'content-type': type }), limits),
      ).toEqual({
        ok: false,
        code: 'upstream',
        reason: 'media',
      });
    },
  );

  it('refuses a missing media type and keeps a planted one out of the result', () => {
    expect(readAnswer(answer(200, '{}', {}), limits)).toMatchObject({
      reason: 'media',
    });
    const type = `text/html; x=${canaries.token.value}`;
    assertPlanted(type, [canaries.token], 'media type');
    const read = readAnswer(
      answer(200, '{}', { 'content-type': type }),
      limits,
    );
    expect(read).toEqual({ ok: false, code: 'upstream', reason: 'media' });
    assertNoCanary(read, canaries.all, 'result');
  });

  it('refuses a byte order mark before decoding and never parses', () => {
    const parse = vi.spyOn(JSON, 'parse');
    const body = new Uint8Array([0xef, 0xbb, 0xbf, ...encoder.encode('{}')]);
    expect(readAnswer(answer(200, body), limits)).toEqual({
      ok: false,
      code: 'upstream',
      reason: 'bom',
    });
    expect(parse).not.toHaveBeenCalled();
    expect(readAnswer(answer(200, '{"a":"﻿"}'), limits).ok).toBe(true);
  });

  it('keeps a byte order mark when decoding, so JSON.parse would refuse it too', () => {
    const decoded = new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: true,
    }).decode(new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]));
    expect(decoded.charCodeAt(0)).toBe(0xfeff);
    expect(() => {
      JSON.parse(decoded);
    }).toThrow();
  });

  it('refuses invalid UTF-8, an empty body and a root that is no object', () => {
    expect(
      readAnswer(answer(200, new Uint8Array([0x7b, 0xff, 0x7d])), limits),
    ).toMatchObject({ reason: 'utf8' });
    expect(readAnswer(answer(200, ''), limits)).toMatchObject({
      code: 'upstream',
      reason: 'json',
    });
    expect(readAnswer(answer(200, '{'), limits)).toMatchObject({
      reason: 'json',
    });
    for (const root of ['null', '1', '"x"', '[]', 'true']) {
      expect(readAnswer(answer(200, root), limits)).toMatchObject({
        code: 'upstream',
        reason: 'shape',
      });
    }
  });

  it('refuses too many levels or elements before JSON.parse runs', () => {
    const parse = vi.spyOn(JSON, 'parse');
    expect(
      readAnswer(
        answer(200, `{"a":${'['.repeat(17)}${']'.repeat(17)}}`),
        limits,
      ),
    ).toEqual({
      ok: false,
      code: 'upstream',
      reason: 'shape',
    });
    expect(
      readAnswer(answer(200, `{"a":[${'1,'.repeat(100)}1]}`), limits),
    ).toMatchObject({ reason: 'shape' });
    expect(parse).not.toHaveBeenCalled();
  });

  it('never decodes the body of an error and keeps its values out', () => {
    const decode = vi.spyOn(TextDecoder.prototype, 'decode');
    const fields = {
      message: canaries.token.value,
      translatedMessage: canaries.email.value,
      messageKey: canaries.name.value,
      args: [canaries.phone.value],
      errors: [{ value: canaries.token.value }],
    };
    const body = JSON.stringify(fields);
    assertPlanted(fields, canaries.all, 'error body');
    for (const status of [400, 401, 403, 404, 429, 500]) {
      const read = readAnswer(answer(status, body), limits);
      expect(read.ok).toBe(false);
      assertNoCanary(read, canaries.all, `result of ${String(status)}`);
    }
    expect(decode).not.toHaveBeenCalled();
  });
});
