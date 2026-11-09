import { describe, expect, it } from 'vitest';

import type { HttpResponse } from '../http/index.js';
import {
  modelAnswerLimits,
  parseModelJson,
  readModelAnswer,
} from './answer.js';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

const response = (
  body: Uint8Array | string,
  status = 200,
  contentType: string | null = 'application/json',
): HttpResponse =>
  Object.freeze({
    status,
    headers: Object.freeze(
      contentType === null ? {} : { 'content-type': contentType },
    ),
    body: typeof body === 'string' ? encode(body) : body,
  });

describe('readModelAnswer', () => {
  it('reads an object of JSON', () => {
    const read = readModelAnswer(
      response('{"choices":[]}', 200, 'application/json; charset=utf-8'),
    );
    expect(read).toEqual({ ok: true, root: { choices: [] } });
    expect(Object.isFrozen(read)).toBe(true);
    expect(readModelAnswer(response('{}'))).toEqual({ ok: true, root: {} });
  });

  it.each([
    [400, 'config'],
    [404, 'config'],
    [422, 'config'],
    [401, 'auth'],
    [403, 'permission'],
    [429, 'rate_limited'],
    [500, 'upstream'],
    [503, 'upstream'],
    [201, 'upstream'],
  ])('gives %i the code %s without reading the body', (status, code) => {
    expect(readModelAnswer(response('{"error":"text"}', status))).toEqual({
      ok: false,
      code,
      reason: 'status',
    });
  });

  it.each([
    ['no media type', response('{}', 200, null)],
    ['text', response('{}', 200, 'text/plain')],
    [
      'a media type that only starts like JSON',
      response('{}', 200, 'application/jsonx'),
    ],
  ])('refuses %s', (_case, answer) => {
    expect(readModelAnswer(answer)).toEqual({
      ok: false,
      code: 'upstream',
      reason: 'media',
    });
  });

  it('refuses a byte order mark and invalid UTF-8', () => {
    expect(
      readModelAnswer(response(new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]))),
    ).toMatchObject({ ok: false, reason: 'bom' });
    for (const bytes of [
      [0x7b, 0xff, 0x7d],
      [0xef, 0xbb, 0x41],
      [0xef, 0x41, 0x41],
    ]) {
      expect(readModelAnswer(response(new Uint8Array(bytes)))).toMatchObject({
        ok: false,
        reason: 'utf8',
      });
    }
  });

  it('refuses a shape too deep, text that is no JSON and JSON that is no object', () => {
    const deep = `${'['.repeat(modelAnswerLimits.maxDepth + 1)}${']'.repeat(modelAnswerLimits.maxDepth + 1)}`;
    expect(readModelAnswer(response(deep))).toMatchObject({ reason: 'shape' });
    expect(readModelAnswer(response('{"a":'))).toMatchObject({
      reason: 'json',
    });
    for (const text of ['[1]', 'null', '"text"']) {
      expect(readModelAnswer(response(text))).toMatchObject({
        reason: 'shape',
      });
    }
  });
});

describe('parseModelJson', () => {
  it.each([
    ['plain JSON', '{"a":1}'],
    ['JSON with blanks around it', '  \n{"a":1}\n '],
    ['JSON in a fence with the language', '```json\n{"a":1}\n```'],
    ['JSON in a fence without the language', '```\n{"a":1}\n```'],
  ])('reads %s', (_case, text) => {
    expect(parseModelJson(text)).toEqual({ ok: true, root: { a: 1 } });
  });

  it.each([
    ['an empty text', '', 'json'],
    ['a fence on one line', '```{"a":1}```', 'json'],
    ['three backticks alone', '```', 'json'],
    ['text before the JSON', 'Here it is: {"a":1}', 'json'],
    ['a fence inside the text', 'x ```json\n{"a":1}\n```', 'json'],
    ['a fence that does not close', '```json\n{"a":1}', 'json'],
    ['an array', '[{"a":1}]', 'shape'],
  ])('refuses %s', (_case, text, reason) => {
    expect(parseModelJson(text)).toMatchObject({
      ok: false,
      code: 'upstream',
      reason,
    });
  });

  it('refuses more elements than the limit', () => {
    const many = `{"a":[${Array.from({ length: modelAnswerLimits.maxElements }, () => '1').join(',')}]}`;
    expect(parseModelJson(many)).toMatchObject({ reason: 'shape' });
  });
});
