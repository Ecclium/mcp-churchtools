import type { OperationFact } from '@ecclium/mcp-churchtools-docs-index';
import { describe, expect, it } from 'vitest';

import { renderDefinition, shapeHead, shapeLines } from './definition.js';

// The definition of an operation as text (ADR 0066): one line for each
// field, two spaces of indent for each level, descriptions of fields on
// one line, the description of the operation with its own lines.

describe('shapeHead', () => {
  it('names types, format, schema, values and description on one line', () => {
    expect(
      shapeHead({
        type: ['integer', 'null'],
        format: 'int64',
        description: 'The ID\n  of a thing.',
      }),
    ).toBe('integer or null, format int64. The ID of a thing.');
    expect(
      shapeHead({ type: ['string'], enum: ['ASC', 'DESC', null, 1] }),
    ).toBe('string, one of "ASC", "DESC", null, 1');
    expect(shapeHead({ ref: 'SyntheticMember' })).toBe(
      'schema SyntheticMember',
    );
    expect(shapeHead({})).toBe('any');
  });
});

describe('shapeLines', () => {
  it('writes properties, items and further properties with their depth', () => {
    expect(
      shapeLines(
        {
          type: ['object'],
          properties: [
            {
              name: 'data',
              required: true,
              schema: {
                type: ['array'],
                items: {
                  type: ['object'],
                  properties: [
                    {
                      name: 'id',
                      required: true,
                      schema: { type: ['integer'] },
                    },
                  ],
                  additionalProperties: true,
                },
              },
            },
            {
              name: 'meta',
              required: false,
              schema: {
                type: ['object'],
                additionalProperties: { type: ['string'] },
              },
            },
          ],
        },
        1,
      ),
    ).toEqual([
      '  - data (required): array',
      '    - items: object',
      '      - id (required): integer',
      '      - other properties: any',
      '  - meta: object',
      '    - other properties: string',
    ]);
  });

  it('writes each part of anyOf, oneOf and allOf', () => {
    expect(
      shapeLines(
        {
          anyOf: [{ type: ['string'] }, { type: ['integer'] }],
          oneOf: [{ ref: 'A' }],
          allOf: [
            {
              type: ['object'],
              properties: [
                { name: 'x', required: false, schema: { type: ['boolean'] } },
              ],
            },
          ],
        },
        0,
      ),
    ).toEqual([
      '- any of:',
      '  - string',
      '  - integer',
      '- one of:',
      '  - schema A',
      '- all of:',
      '  - object',
      '    - x: boolean',
    ]);
    expect(shapeLines({ type: ['string'] }, 3)).toEqual([]);
  });
});

describe('renderDefinition', () => {
  const fact: OperationFact = {
    operationId: 'postSyntheticThing',
    method: 'post',
    path: '/synthetic/things',
    tags: ['Synthetic', 'Things'],
    summary: 'Create a synthetic thing',
    description: 'Creates a thing.\n\n- one\n- two',
    deprecated: false,
    parameters: [
      {
        name: 'dry',
        in: 'query',
        required: false,
        description: 'Only check.',
        schema: { type: ['boolean'] },
      },
      { name: 'X-Synthetic', in: 'header', required: true },
    ],
    requestBody: {
      required: true,
      description: 'The new thing.',
      content: [
        {
          mediaType: 'application/json',
          schema: {
            type: ['object'],
            properties: [
              { name: 'name', required: true, schema: { type: ['string'] } },
            ],
          },
        },
        { mediaType: 'text/plain' },
      ],
    },
    responses: [
      { status: '201', description: 'Created.', content: [] },
      {
        status: '4XX',
        content: [{ mediaType: '*/*', schema: { ref: 'Error' } }],
      },
    ],
  };

  it('writes every part of an operation, the description with its lines', () => {
    expect(renderDefinition(fact).split('\n')).toEqual([
      'Tags: Synthetic, Things',
      'Description: Creates a thing.',
      '',
      '- one',
      '- two',
      'Parameters:',
      '- dry (query): boolean. Only check.',
      '- X-Synthetic (header, required): any',
      'Request body (required): The new thing.',
      '  - application/json: object',
      '    - name (required): string',
      '  - text/plain',
      'Responses:',
      '- 201: Created.',
      '- 4XX:',
      '  - */*: schema Error',
    ]);
  });

  it('says none where an operation has no parameters, body or answers', () => {
    expect(
      renderDefinition({
        operationId: 'getNothing',
        method: 'get',
        path: '/nothing',
        tags: [],
        deprecated: false,
        parameters: [],
        responses: [],
      }),
    ).toBe('Parameters: none\nRequest body: none\nResponses: none');
  });
});
