// Shared test support for the spike probes. Everything here is synthetic:
// the OpenAPI document only mirrors the paths the probes use, and every
// canary value is made up at run time (see tests/fixtures/README.md).
import { randomBytes, randomInt } from 'node:crypto';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

import type { Io } from '../../scripts/spike/lib/output.mts';

/** The placeholder instance of the project. */
export const origin = 'https://example.church.tools';

/** Values that must never appear in any output of a probe. */
export interface Canaries {
  readonly token: string;
  readonly personName: string;
  readonly personEmail: string;
  readonly personId: string;
  readonly groupName: string;
  readonly dataKey: string;
  readonly number: number;
  readonly headerValue: string;
  readonly cookieName: string;
  readonly cookieValue: string;
}

/**
 * Makes a fresh set of canary values.
 *
 * @returns Canary values, partly random, so no test passes by chance.
 */
export function makeCanaries(): Canaries {
  const tag = randomBytes(4).toString('hex');
  return {
    token: `ct-CANARY-${randomBytes(16).toString('hex')}`,
    personName: `Max Mustermann${tag}`,
    personEmail: `max.mustermann.${tag}@example.org`,
    personId: 'person-id-1',
    groupName: 'Jugend Zürich',
    dataKey: '12',
    number: randomInt(100_000, 999_999),
    headerValue: `kanarie-${tag}`,
    cookieName: `ct_kanarie_${tag}`,
    cookieValue: randomBytes(12).toString('hex'),
  };
}

/**
 * Lists every text that must not appear in an output, including values of
 * the local machine.
 *
 * @param canaries - The canaries of the test.
 * @param extra - Further values, such as temporary paths.
 * @returns Texts to look for, in lower case.
 */
export function forbiddenTexts(
  canaries: Canaries,
  ...extra: readonly string[]
): string[] {
  const texts = [
    canaries.token,
    canaries.personName,
    canaries.personEmail,
    canaries.personId,
    canaries.groupName,
    String(canaries.number),
    canaries.headerValue,
    canaries.cookieName,
    canaries.cookieValue,
    'example.church.tools',
    homedir(),
    userInfo().username,
    ...extra,
  ];
  return texts.flatMap((text) => [
    text.toLowerCase(),
    encodeURIComponent(text).toLowerCase(),
  ]);
}

/** Captures what a probe writes. */
export interface Capture {
  readonly io: Io;
  readonly stdout: () => string;
  readonly stderr: () => string;
}

/**
 * Creates an output that records everything.
 *
 * @returns The output and accessors for what was written.
 */
export function capture(): Capture {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      stdout: (text) => {
        out.push(text);
      },
      stderr: (text) => {
        err.push(text);
      },
    },
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  };
}

const integrityLine =
  /^(?:Node\.js v\S+|SHA-256 der Skripte:|[0-9a-f]{64} {2}\S+)$/;

/**
 * Lists the forbidden texts that appear in what a probe wrote.
 *
 * The integrity lines at the start of stderr are left out: they hold only
 * the Node.js version and the hashes of the scripts, and a hash can contain
 * a random canary number by chance.
 *
 * @param output - What the probe wrote.
 * @param forbidden - Texts from {@link forbiddenTexts}, in lower case.
 * @returns The forbidden texts found, empty if there are none.
 */
export function leaks(output: Capture, forbidden: readonly string[]): string[] {
  const text = `${output.stdout()}${output.stderr()}`
    .split('\n')
    .filter((line) => !integrityLine.test(line))
    .join('\n')
    .toLowerCase();
  return forbidden.filter((secret) => text.includes(secret));
}

/**
 * Creates a private folder and a token file, as the README asks for.
 *
 * @param token - Token to write.
 * @returns Paths of the folder, the token file and a not yet existing state file.
 */
export function privateFiles(token: string): {
  folder: string;
  tokenFile: string;
  stateFile: string;
} {
  const folder = mkdtempSync(join(tmpdir(), 'spike-'));
  const tokenFile = join(folder, 'token');
  writeFileSync(tokenFile, `${token}\n`);
  chmodSync(tokenFile, 0o600);
  return { folder, tokenFile, stateFile: join(folder, 'state.json') };
}

const json = (schema: unknown): unknown => ({
  content: { 'application/json': { schema } },
});

/** A synthetic OpenAPI document with the operations the probes use. */
export const specification = {
  openapi: '3.0.3',
  info: { title: 'Synthetic test document', version: '0.0.0' },
  servers: [{ url: `${origin}/api` }],
  paths: {
    '/info': {
      get: {
        responses: { '200': json({ $ref: '#/components/schemas/Info' }) },
      },
    },
    '/whoami': {
      get: {
        parameters: [{ name: 'only_allow_authenticated', in: 'query' }],
        responses: {
          '200': json({
            type: 'object',
            properties: { data: { $ref: '#/components/schemas/Person' } },
          }),
          '401': json({ $ref: '#/components/schemas/Error' }),
        },
      },
    },
    '/permissions/global': {
      get: {
        responses: {
          '200': json({
            type: 'object',
            properties: {
              data: {
                type: 'object',
                additionalProperties: { type: 'object' },
              },
            },
          }),
        },
      },
    },
    '/wiki/pages': {
      get: {
        parameters: [
          { $ref: '#/components/parameters/Page' },
          { name: 'limit', in: 'query' },
          { name: 'wiki_category_ids[]', in: 'query' },
        ],
        responses: {
          '200': json({ $ref: '#/components/schemas/PageList' }),
          '4XX': json({ $ref: '#/components/schemas/Error' }),
        },
      },
    },
    '/wiki/categories/{categoryId}/pages': {
      get: {
        responses: {
          '200': json({ $ref: '#/components/schemas/PageList' }),
          default: json({ $ref: '#/components/schemas/Error' }),
        },
      },
      post: { responses: {} },
    },
    '/wiki/categories/{categoryId}/pages/{identifier}': {
      get: {
        responses: {
          '200': json({
            type: 'object',
            properties: { data: { $ref: '#/components/schemas/Page' } },
          }),
          default: json({ $ref: '#/components/schemas/Error' }),
        },
      },
      patch: { responses: {} },
    },
    '/wiki/categories/{categoryId}/pages/{identifier}/versions': {
      get: {
        responses: {
          '200': json({
            type: 'object',
            properties: {
              data: {
                type: 'array',
                items: { $ref: '#/components/schemas/Page' },
              },
            },
          }),
        },
      },
    },
    '/wiki/categories/{categoryId}/pages/{identifier}/versions/{version}': {
      get: {
        responses: {
          '200': json({
            type: 'object',
            properties: { data: { $ref: '#/components/schemas/Page' } },
          }),
        },
      },
    },
  },
  components: {
    parameters: { Page: { name: 'page', in: 'query' } },
    schemas: {
      Info: {
        type: 'object',
        properties: {
          version: { type: 'string' },
          siteName: { type: 'string' },
        },
      },
      Person: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          firstName: { type: 'string' },
          lastName: { type: 'string' },
          email: { type: 'string' },
        },
      },
      Error: {
        type: 'object',
        properties: { message: { type: 'string' }, args: { type: 'object' } },
      },
      Pagination: {
        type: 'object',
        properties: {
          total: { type: 'integer' },
          limit: { type: 'integer' },
          current: { type: 'integer' },
          lastPage: { type: 'integer' },
        },
      },
      Page: {
        type: 'object',
        properties: {
          identifier: { type: 'string' },
          title: { type: 'string' },
          text: { type: 'string' },
          version: { type: 'integer' },
          isMarkdown: { type: 'boolean' },
        },
      },
      PageList: {
        type: 'object',
        properties: {
          data: { type: 'array', items: { $ref: '#/components/schemas/Page' } },
          meta: {
            type: 'object',
            properties: {
              pagination: { $ref: '#/components/schemas/Pagination' },
            },
          },
        },
      },
    },
  },
} as const;
