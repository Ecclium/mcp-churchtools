import { describe, expect, it } from 'vitest';

import { Guard, containsWord } from '../../scripts/spike/lib/guard.mts';

describe('Guard', () => {
  it('lets fixed words pass and reports unknown ones by position only', () => {
    const guard = new Guard();
    guard.allowFixed('status', 'vorhanden', 404);
    expect(guard.check({ status: 'vorhanden', code: 404 })).toEqual(['/#1']);
    expect(guard.check({ status: 'Max Mustermann' })).toEqual(['/status']);
    expect(guard.check({ status: [404, 'Max Mustermann'] })).toEqual([
      '/status/1',
    ]);
  });

  it('checks keys taken from the instance against the block list', () => {
    const guard = new Guard();
    guard.allowFixed('felder');
    guard.allowChecked('firstName');
    guard.allowChecked('jugend zürich');
    guard.block('Jugend Zürich');
    expect(guard.check({ felder: { firstName: null } })).toEqual([]);
    expect(guard.check({ felder: { 'jugend zürich': null } })).toEqual([
      '/felder/#0',
    ]);
  });

  it('blocks whole words only, so ordinary keys survive short values', () => {
    const guard = new Guard();
    guard.allowChecked('wikiCategory');
    guard.allowChecked('wiki category');
    guard.block('wiki');
    expect(guard.check({ wikiCategory: null })).toEqual([]);
    expect(guard.check({ 'wiki category': null })).toEqual(['/#0']);
  });

  it('blocks numbers from responses inside keys', () => {
    const guard = new Guard();
    guard.allowChecked('field4711');
    guard.allowChecked('field47110');
    guard.block(4711);
    expect(guard.check({ field4711: null })).toEqual(['/#0']);
    expect(guard.check({ field47110: null })).toEqual([]);
  });

  it('also looks for the URL-encoded form', () => {
    const guard = new Guard();
    guard.allowChecked('Jugend%20Z%C3%BCrich');
    guard.block('Jugend Zürich');
    expect(guard.check({ 'Jugend%20Z%C3%BCrich': null })).toEqual(['/#0']);
  });

  it('never lets short unknown text pass, although it is not blocked', () => {
    const guard = new Guard();
    guard.block('12');
    expect(guard.check({ '12': null })).toEqual(['/#0']);
    expect(guard.check('12')).toEqual(['/']);
  });

  it('lets the version pass in its only allowed form', () => {
    const guard = new Guard();
    guard.allowVersion('3.136');
    guard.block('3.136');
    expect(guard.check('3.136')).toEqual([]);
    expect(guard.check('3.136.2')).toEqual(['/']);
    expect(() => {
      guard.allowVersion('3.136.2');
    }).toThrow('INTERN');
  });

  it('adds strings and numbers of a response, but not its keys', () => {
    const guard = new Guard();
    guard.allowChecked('name');
    guard.allowChecked('Max Mustermann');
    guard.blockAll({ name: 'Max Mustermann', list: [{ id: 4711 }] });
    expect(guard.check({ name: null })).toEqual([]);
    expect(guard.check({ 'Max Mustermann': null })).toEqual(['/#0']);
  });
});

describe('containsWord', () => {
  it.each([
    ['max mustermann', 'max', true],
    ['maximal', 'max', false],
    ['jugend zürich', 'zürich', true],
    ['jugendzürich', 'zürich', false],
    ['x-max-y', 'max', true],
    ['host.example.org', 'example.org', true],
  ])('%j contains %j as a word: %s', (text, part, expected) => {
    expect(containsWord(text, part)).toBe(expected);
  });
});
