// The stand-ins of the E2E job (ADR 0036, ADR 0052): ChurchTools, a model
// and a decoy, each a process of its own in a container of
// scripts/e2e/compose.yaml, with TLS from certificates the driver makes at
// run time. Only built-ins of Node.js, so the container needs nothing but
// the image of Node.js.
//
//   node scripts/e2e/mock.mts churchtools|model|decoy
//
// ChurchTools keeps one category of the wiki with one page and answers the
// requests of a run that writes there, in the forms the client reads
// (packages/core/src/churchtools/schemas.ts): whoami, the rights of an
// account, the categories, the list of pages, the page and its PATCH. A
// page gets a new version only for a new text (F10) and keeps it without
// the white space at its ends (F51). The model answers the chat interface
// with one block for the routine of the job, numbered, so that every run
// wants another section. The decoy is on no list and only counts
// connections.
//
// On 127.0.0.1:8081, inside its own container only, each stand-in gives the
// driver what it saw: method, path and status of every request, never a
// body, a query or a token, and for ChurchTools the version and text of the
// page. Everything is made up by the driver; no answer is copied from an
// instance (tests/fixtures/README.md).
import { readFileSync } from 'node:fs';
import {
  createServer as createPlainServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import process from 'node:process';

/** The roles of a stand-in. */
export const mockRoles = ['churchtools', 'model', 'decoy'] as const;
/** One role. */
export type MockRole = (typeof mockRoles)[number];

/** The port of the stand-in in the network of the job. */
export const mockPort = 443;
/** The port of the report, on loopback inside the container. */
export const reportPort = 8081;
/** The line on stdout once a stand-in listens. */
export const readyLine = 'bereit';

/** An account of ChurchTools: its token, its ID and its rights. */
export interface MockAccount {
  readonly token: string;
  readonly id: number;
  readonly rights: Readonly<Record<string, unknown>>;
}

/** What the driver gives the stand-ins, in /e2e/mock.json. */
export interface MockConfig {
  readonly churchtools: {
    readonly accounts: readonly MockAccount[];
    readonly category: { readonly id: number; readonly name: string };
    readonly page: {
      readonly guid: string;
      readonly title: string;
      readonly text: string;
    };
  };
  readonly model: {
    /** The key the adapter sends as a bearer token. */
    readonly key: string;
    /** The block of the output schema and its one text field. */
    readonly block: string;
    readonly field: string;
  };
}

/** One request a stand-in answered, without body, query and token. */
export interface MockCall {
  readonly method: string;
  readonly path: string;
  readonly status: number;
}

/** What a stand-in reports to the driver. */
export interface MockReport {
  readonly role: MockRole;
  readonly calls: readonly MockCall[];
  /** Connections over TCP, also those that never sent a request. */
  readonly connections: number;
  /** The page of ChurchTools, for its role only. */
  readonly page?: { readonly version: number; readonly text: string };
}

/** A request as a handler sees it. */
interface MockRequest {
  readonly method: string;
  readonly url: URL;
  readonly authorization: string | undefined;
  readonly body: string;
}

/** An answer: a status and a JSON body. */
interface MockAnswer {
  readonly status: number;
  readonly body: unknown;
}

// The longest body a stand-in reads; a run sends far less.
const maxBodyBytes = 1024 * 1024;

const pagePath = /^\/api\/wiki\/categories\/(\d+)\/pages\/([0-9a-f-]{36})$/u;

// ChurchTools stores a text without the white space `trim` of PHP removes
// at both ends (F51), written here apart from the core.
const asStored = (text: string): string =>
  text.replace(/^[ \t\n\r\v]+/u, '').replace(/[ \t\n\r\v]+$/u, '');

/**
 * Builds the handler of ChurchTools over one page and the report of its
 * state.
 *
 * @param config - The accounts, the category and the page.
 * @returns The handler and the page as it stands.
 */
export function createChurchTools(config: MockConfig['churchtools']): {
  readonly respond: (request: MockRequest) => MockAnswer;
  readonly page: () => { readonly version: number; readonly text: string };
} {
  const page = { version: 1, text: asStored(config.page.text) };
  const accountOf = (
    authorization: string | undefined,
  ): MockAccount | undefined =>
    config.accounts.find(
      (account) => authorization === `Login ${account.token}`,
    );
  const ok = (data: unknown): MockAnswer => ({ status: 200, body: { data } });
  const respond = (request: MockRequest): MockAnswer => {
    const account = accountOf(request.authorization);
    if (account === undefined) return { status: 401, body: {} };
    const { method, url } = request;
    if (method === 'GET' && url.pathname === '/api/whoami') {
      return ok({
        id: account.id,
        guid: `00000000-0000-4000-8000-${String(account.id).padStart(12, '0')}`,
        firstName: 'Konto',
        lastName: `E2E ${String(account.id)}`,
      });
    }
    if (method === 'GET' && url.pathname === '/api/permissions/global') {
      return ok(account.rights);
    }
    if (method === 'GET' && url.pathname === '/api/wiki/categories') {
      return ok([{ id: config.category.id, name: config.category.name }]);
    }
    if (method === 'GET' && url.pathname === '/api/wiki/pages') {
      const asked = url.searchParams.getAll('wiki_category_ids[]');
      const data = asked.includes(String(config.category.id))
        ? [
            {
              guid: config.page.guid,
              title: config.page.title,
              isMarkdown: true,
              version: page.version,
              meta: { modifiedDate: '2026-11-02T08:00:00Z' },
            },
          ]
        : [];
      return {
        status: 200,
        body: {
          data,
          meta: {
            count: data.length,
            pagination: {
              total: data.length,
              limit: 25,
              current: 1,
              lastPage: 1,
            },
          },
        },
      };
    }
    const [, category, guid] = pagePath.exec(url.pathname) ?? [];
    if (category !== undefined && guid !== undefined) {
      const known =
        Number(category) === config.category.id && guid === config.page.guid;
      if (!known) return { status: 404, body: {} };
      if (method === 'GET') {
        return ok({
          title: config.page.title,
          isMarkdown: true,
          version: page.version,
          text: page.text,
          wikiCategory: { id: config.category.id },
        });
      }
      if (method === 'PATCH') {
        let text: unknown;
        try {
          text = (JSON.parse(request.body) as { text?: unknown }).text;
        } catch {
          return { status: 400, body: {} };
        }
        if (typeof text !== 'string' || text === '') {
          return { status: 400, body: {} };
        }
        const stored = asStored(text);
        if (stored !== page.text) {
          page.text = stored;
          page.version += 1;
        }
        return { status: 200, body: {} };
      }
    }
    return { status: 404, body: {} };
  };
  return {
    respond,
    page: () => ({ version: page.version, text: page.text }),
  };
}

/**
 * Builds the handler of the model: the chat interface after the example of
 * OpenAI, with one block whose text carries the number of the call.
 *
 * @param config - The key and the block of the routine.
 * @returns The handler.
 */
export function createModel(
  config: MockConfig['model'],
): (request: MockRequest) => MockAnswer {
  let count = 0;
  return (request) => {
    if (request.authorization !== `Bearer ${config.key}`) {
      return { status: 401, body: {} };
    }
    if (
      request.method !== 'POST' ||
      request.url.pathname !== '/v1/chat/completions'
    ) {
      return { status: 404, body: {} };
    }
    count += 1;
    const content = JSON.stringify({
      [config.block]: [{ [config.field]: `Eintrag ${String(count)}` }],
    });
    return {
      status: 200,
      body: {
        choices: [{ message: { content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      },
    };
  };
}

// Reads the body up to the limit; a longer one ends as 413.
const bodyOf = (request: IncomingMessage): Promise<string | undefined> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= maxBodyBytes) chunks.push(chunk);
    });
    request.on('end', () => {
      resolve(
        size > maxBodyBytes
          ? undefined
          : Buffer.concat(chunks).toString('utf8'),
      );
    });
    request.on('error', () => {
      resolve(undefined);
    });
  });

const send = (response: ServerResponse, answer: MockAnswer): void => {
  response.writeHead(answer.status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(answer.body));
};

const main = (): void => {
  const role = process.argv[2] as MockRole | undefined;
  if (role === undefined || !mockRoles.includes(role)) {
    process.stderr.write('Aufruf: mock.mts churchtools|model|decoy\n');
    process.exit(64);
  }
  const config = JSON.parse(
    readFileSync('/e2e/mock.json', 'utf8'),
  ) as MockConfig;
  // A reset starts over with the page and the count of the model, without
  // a restart: a new container could get another address, which Squid
  // would not know yet.
  let churchtools: ReturnType<typeof createChurchTools> | undefined;
  let model: ReturnType<typeof createModel> | undefined;
  const calls: MockCall[] = [];
  let connections = 0;
  const reset = (): void => {
    churchtools =
      role === 'churchtools'
        ? createChurchTools(config.churchtools)
        : undefined;
    model = role === 'model' ? createModel(config.model) : undefined;
    calls.length = 0;
    connections = 0;
  };
  reset();

  const server = createTlsServer(
    {
      key: readFileSync(`/e2e/tls/${role}.key`),
      cert: readFileSync(`/e2e/tls/${role}.crt`),
    },
    (request, response) => {
      void bodyOf(request).then((body) => {
        const url = new URL(request.url ?? '/', 'https://mock.invalid');
        const answer: MockAnswer =
          body === undefined
            ? { status: 413, body: {} }
            : (
                churchtools?.respond ??
                model ??
                (() => ({ status: 404, body: {} }))
              )({
                method: request.method ?? 'GET',
                url,
                authorization: request.headers.authorization,
                body,
              });
        calls.push({
          method: request.method ?? 'GET',
          path: url.pathname,
          status: answer.status,
        });
        send(response, answer);
      });
    },
  );
  server.on('connection', () => {
    connections += 1;
  });

  const report = createPlainServer((request, response) => {
    if (request.method === 'POST' && request.url === '/reset') reset();
    const state: MockReport = {
      role,
      calls,
      connections,
      ...(churchtools === undefined ? {} : { page: churchtools.page() }),
    };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(state));
  });

  server.listen(mockPort, '0.0.0.0', () => {
    report.listen(reportPort, '127.0.0.1', () => {
      process.stdout.write(`${readyLine}\n`);
    });
  });
  const stop = (): void => {
    server.close();
    report.close();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
};

if (import.meta.main) main();
