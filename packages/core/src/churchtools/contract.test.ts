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
});
