import { describe, expect, it } from 'vitest';

import {
  hasHtmlTag,
  looksLikeHtmlPage,
  looksLikeOpenApiDocument,
} from './raw-sources.js';

// The recognition of raw sources (ADR 0066), each with the form it must
// catch and a near miss it must let pass. Documents in JSON are built at
// run time, so that this file does not look like one itself to the check
// of the whole tree.

const json = (value: unknown, space?: number) =>
  JSON.stringify(value, null, space);

describe('looksLikeOpenApiDocument', () => {
  it.each([
    ['JSON', json({ openapi: '3.1.0', info: {}, paths: {} })],
    ['JSON with spaces', json({ swagger: '2.0', paths: {} }, 2)],
    ['YAML', 'openapi: 3.1.0\ninfo:\n  title: x\npaths:\n  /a: {}\n'],
  ])('finds %s', (_name, text) => {
    expect(looksLikeOpenApiDocument(text)).toBe(true);
  });

  it.each([
    ['facts without paths', json({ openapi: '3.1.0' })],
    ['paths without openapi', json({ paths: {} })],
    ['code that names both', "const keys = ['openapi', 'paths'];"],
    ['indented YAML keys', 'doc:\n  openapi: 3.1.0\n  paths: {}\n'],
  ])('lets %s pass', (_name, text) => {
    expect(looksLikeOpenApiDocument(text)).toBe(false);
  });
});

describe('looksLikeHtmlPage', () => {
  it.each([
    ['a doctype', '<!DOCTYPE html>\n<html lang="de"></html>'],
    ['an element html after white space', '\n  <html>'],
    ['a byte order mark', '\uFEFF<!doctype html>'],
  ])('finds %s', (_name, text) => {
    expect(looksLikeHtmlPage(text)).toBe(true);
  });

  it.each([
    ['code with HTML inside', 'const page = "<html><body></body></html>";'],
    ['Markdown', '# Titel\n\nText'],
    ['an element htmlx', '<htmlx>'],
  ])('lets %s pass', (_name, text) => {
    expect(looksLikeHtmlPage(text)).toBe(false);
  });
});

describe('hasHtmlTag', () => {
  it.each([
    ['a start tag', 'Use <b>bold</b>'],
    ['an end tag', 'end</p>'],
    ['a tag with attributes', '<a href="/de/">x</a>'],
    ['a closed tag', 'line<br/>'],
    ['a comment', 'text <!-- hidden -->'],
    ['a doctype', '<!DOCTYPE html>'],
    ['a tag at the end', 'text <img'],
  ])('finds %s', (_name, text) => {
    expect(hasHtmlTag(`${text} `)).toBe(true);
  });

  it.each([
    ['a comparison', '1 < 2 and 3 > 2'],
    ['Markdown', '**fett** und [Link](/de/help/)'],
    ['an arrow', 'a <- b'],
    ['an autolink without host check', '<https:'],
  ])('lets %s pass', (_name, text) => {
    expect(hasHtmlTag(text)).toBe(false);
  });

  it('stays fast on a long text', () => {
    const start = performance.now();
    expect(hasHtmlTag('<'.repeat(200_000))).toBe(false);
    expect(
      looksLikeOpenApiDocument(`${json('openapi')}${' '.repeat(200_000)}`),
    ).toBe(false);
    expect(performance.now() - start).toBeLessThan(2000);
  });
});
