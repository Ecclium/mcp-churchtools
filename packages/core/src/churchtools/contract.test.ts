import { describe, expect, it } from 'vitest';

import { describeContract } from './contract.js';

// contract.json is what the local contract check in scripts/contract/
// reads. Any change of a schema turns this test red until the file is
// updated with `vitest -u`.
describe('describeContract', () => {
  it('matches contract.json', async () => {
    await expect(
      `${JSON.stringify(describeContract(), null, 2)}\n`,
    ).toMatchFileSnapshot('./contract.json');
  });

  it('describes what ChurchTools may send, so objects stay open', () => {
    const whoami = describeContract().whoami.response as {
      additionalProperties?: unknown;
    };
    expect(whoami.additionalProperties).toBeUndefined();
  });

  // A write is described as what the client sends and nothing besides
  // (ADR 0072): a closed object, and a new page always in Markdown.
  it('describes the body of a write as closed, with isMarkdown always true', () => {
    const { wikiPageCreate, wikiPageUpdate } = describeContract();
    expect(wikiPageCreate.request).toMatchObject({
      additionalProperties: false,
      required: ['title', 'text', 'isMarkdown'],
      properties: { isMarkdown: { type: 'boolean', const: true } },
    });
    expect(wikiPageUpdate.request).toMatchObject({
      additionalProperties: false,
      required: ['text'],
    });
    expect(Object.keys(wikiPageUpdate.request.properties ?? {})).toEqual([
      'text',
    ]);
    expect(wikiPageCreate.status).toBe(201);
    expect(wikiPageUpdate.status).toBe(200);
    expect('response' in wikiPageUpdate).toBe(false);
  });
});
