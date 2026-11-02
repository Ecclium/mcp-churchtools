import { contentViolationKinds } from '@ecclium/mcp-churchtools-plugin-api';
import { describe, expect, it } from 'vitest';

import { contentSentences } from '../content/index.js';
import { describeError, maxMessageLength } from '../errors/index.js';
import { ContentRefusal } from './content-gate.js';

describe('ContentRefusal', () => {
  it('names as many reasons as fit in one message, in their order', () => {
    const refusal = new ContentRefusal(contentViolationKinds);
    const { message } = describeError(refusal.error);
    expect(message.length).toBeLessThanOrEqual(maxMessageLength);
    expect(message.startsWith(contentSentences.tooLong)).toBe(true);
    expect(refusal.error.message).toBe(message);
    expect(refusal.violations).toEqual(contentViolationKinds);
  });

  it('gives the model the sentence of each reason of a short list', () => {
    const refusal = new ContentRefusal(['webAddress', 'contact', 'masked']);
    expect(describeError(refusal.error).message).toBe(
      `${contentSentences.webAddress} ${contentSentences.contact}`,
    );
  });
});
