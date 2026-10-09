// A synthetic instance for the probes of the write account. It keeps the
// pages of the write area in memory, answers the documented write
// operations, and fills every answer with canary values. Everything is made
// up at run time (see tests/fixtures/README.md); no real answer is copied.
import { randomBytes, randomInt } from 'node:crypto';
import { join } from 'node:path';

import { instanceId, type SpikeState } from '../../scripts/spike/lib/env.mts';
import { identificationCategoryName } from '../../scripts/spike/lib/gate.mts';
import type { FetchFunction } from '../../scripts/spike/lib/http.mts';
import { asOpenApi } from '../../scripts/spike/lib/spec.mts';
import {
  forbiddenTexts,
  makeCanaries,
  privateFiles,
  specification,
  type Canaries,
} from './support.mts';

/**
 * The placeholder instance of the write tests. The README placeholder under
 * church.tools is refused by the guard, so these tests use a reserved
 * top-level domain.
 */
export const writeOrigin = 'https://demo-tenant.example';

/** The switch that fits {@link writeOrigin}. */
export const writeSwitch = 'demo-tenant';

/** Everything one write test needs. */
export interface WriteSetting {
  readonly canaries: Canaries;
  readonly writeCategory: number;
  readonly identification: number;
  readonly folder: string;
  readonly tokenFile: string;
  readonly stateFile: string;
  readonly writeStateFile: string;
  /** Environment of a probe of the write account. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Environment of 00-inventory with the token of the write account. */
  readonly inventoryEnv: Readonly<Record<string, string | undefined>>;
  readonly forbidden: readonly string[];
}

/**
 * Makes the files and environment of one write test.
 *
 * @returns A fresh setting with random IDs and canaries.
 */
export function writeSetup(): WriteSetting {
  const canaries = makeCanaries();
  const writeCategory = randomInt(10_000, 50_000);
  const identification = writeCategory + randomInt(1, 1000);
  const files = privateFiles(canaries.token);
  const writeStateFile = join(files.folder, 'schreib-state.jsonl');
  return {
    canaries,
    writeCategory,
    identification,
    folder: files.folder,
    tokenFile: files.tokenFile,
    stateFile: files.stateFile,
    writeStateFile,
    env: {
      ECCLIUM_SPIKE_BASE_URL: writeOrigin,
      ECCLIUM_SPIKE_ALLOW_WRITE: writeSwitch,
      ECCLIUM_SPIKE_WRITE_TOKEN_FILE: files.tokenFile,
      ECCLIUM_SPIKE_STATE_FILE: files.stateFile,
      ECCLIUM_SPIKE_WRITE_CATEGORY_ID: String(writeCategory),
      ECCLIUM_SPIKE_WRITE_STATE_FILE: writeStateFile,
    },
    inventoryEnv: {
      ECCLIUM_SPIKE_BASE_URL: writeOrigin,
      ECCLIUM_SPIKE_TOKEN_FILE: files.tokenFile,
      ECCLIUM_SPIKE_STATE_FILE: files.stateFile,
    },
    forbidden: forbiddenTexts(
      canaries,
      files.folder,
      String(writeCategory),
      String(identification),
      'demo-tenant.example',
      writeSwitch,
    ),
  };
}

/**
 * The state 00-inventory would write for the synthetic instance.
 *
 * @param document - The OpenAPI document, by default the synthetic one.
 * @returns A state for {@link writeOrigin}.
 */
export function initialState(document: unknown = specification): SpikeState {
  const parsed = asOpenApi(document);
  if (parsed === undefined) {
    throw new Error('synthetic document is not accepted');
  }
  return {
    format: 'ecclium-spike-state.v1',
    instance: instanceId(writeOrigin),
    version: '3.137',
    specification: parsed,
  };
}

/** One version of a synthetic page. */
export interface SyntheticVersion {
  readonly version: number;
  readonly text: string | null;
  readonly isMarkdown: boolean;
  readonly modifiedDate: string;
}

/** A synthetic page of the write area. */
export interface SyntheticPage {
  readonly guid: string;
  readonly title: string;
  onStartpage: boolean;
  readonly versions: SyntheticVersion[];
}

/** One request the synthetic instance received. */
export interface WriteCall {
  readonly method: string;
  readonly url: URL;
  readonly headers: Headers;
  readonly body: string | undefined;
}

/** How the synthetic instance behaves. */
export interface WriteInstanceOptions {
  /** Body of `GET /api/wiki/categories`, instead of W and K. */
  readonly categories?: unknown;
  /** Status of `GET /api/wiki/categories`. */
  readonly categoriesStatus?: number;
  /** Body of `GET /api/permissions/global`, instead of the narrow rights. */
  readonly rights?: unknown;
  /** The OpenAPI document. */
  readonly document?: unknown;
  /** Pages in the write area before the run, besides the automatic page. */
  readonly extraPages?: readonly SyntheticPage[];
  /** Status for a POST with a title that exists. Default 400. */
  readonly duplicateStatus?: number;
  /** Whether a PATCH takes an undeclared `title`. Default: ignored. */
  readonly honourTitle?: boolean;
  /** Whether a PATCH with a precondition is refused with 412. Default: ignored. */
  readonly honourPreconditions?: boolean;
  /** Whether a PATCH with an unchanged text still creates a version. */
  readonly sameTextNewVersion?: boolean;
  /** Throw a network error on this call number (1-based), after counting it. */
  readonly failOnCall?: number;
  /** Status of the deletion of a page. Default 204. */
  readonly deleteStatus?: number;
}

/** A synthetic instance: fetch, the calls it received and its pages. */
export interface WriteInstance {
  readonly fetch: FetchFunction;
  readonly calls: WriteCall[];
  readonly pages: Map<string, SyntheticPage>;
  /** The automatic page of the write area. */
  readonly autoPage: SyntheticPage;
  /**
   * Saves a page as the web editor would: a new version with a changed text.
   *
   * @param guid - GUID of the page.
   * @param change - How the editor changes the text.
   */
  readonly editorSave: (guid: string, change: (text: string) => string) => void;
}

/**
 * Makes a random GUID in the documented form.
 *
 * @returns A GUID.
 */
export function makeGuid(): string {
  const hex = randomBytes(16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Creates the synthetic instance for one setting.
 *
 * @param setting - The setting of the test.
 * @param options - How the instance behaves.
 * @returns The instance.
 */
export function writeInstance(
  setting: WriteSetting,
  options: WriteInstanceOptions = {},
): WriteInstance {
  const { canaries, writeCategory, identification } = setting;
  const calls: WriteCall[] = [];
  let clock = 0;
  const now = (): string =>
    new Date(Date.UTC(2026, 0, 1, 0, 0, clock++)).toISOString();
  const autoPage: SyntheticPage = {
    guid: makeGuid(),
    title: 'main',
    onStartpage: false,
    versions: [{ version: 1, text: '', isMarkdown: true, modifiedDate: now() }],
  };
  const pages = new Map<string, SyntheticPage>([[autoPage.guid, autoPage]]);
  for (const page of options.extraPages ?? []) {
    pages.set(page.guid, page);
  }

  const person = {
    title: canaries.personName,
    domainType: 'person',
    domainIdentifier: canaries.personId,
    domainAttributes: {
      firstName: canaries.personName,
      lastName: canaries.groupName,
      guid: makeGuid(),
    },
  };
  const category = { id: writeCategory, name: canaries.groupName };
  const answer = (body: unknown, status = 200): Response =>
    new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: {
        'content-type': 'application/json',
        date: new Date(0).toUTCString(),
        'x-kanarie': canaries.headerValue,
        'set-cookie': `${canaries.cookieName}=${canaries.cookieValue}; Path=/; Secure; HttpOnly; SameSite=None`,
      },
    });
  const error = (status: number): Response =>
    answer(
      {
        message: canaries.personName,
        translatedMessage: canaries.groupName,
        messageKey: 'error',
        args: { id: canaries.personId },
        errors: [],
      },
      status,
    );
  const latest = (page: SyntheticPage): SyntheticVersion => {
    const last = page.versions.at(-1);
    if (last === undefined) {
      throw new Error('page without version');
    }
    return last;
  };
  const listEntry = (page: SyntheticPage): Record<string, unknown> => ({
    guid: page.guid,
    identifier: page.guid,
    title: page.title,
    version: latest(page).version,
    isMarkdown: latest(page).isMarkdown,
    onStartpage: page.onStartpage,
    wikiCategory: category,
    permissions: { canEdit: true, canDelete: page !== autoPage },
    meta: { modifiedDate: latest(page).modifiedDate, modifiedPerson: person },
  });
  const pageData = (
    page: SyntheticPage,
    version: SyntheticVersion = latest(page),
  ): Record<string, unknown> => ({
    ...listEntry(page),
    version: version.version,
    text: version.text,
    isMarkdown: version.isMarkdown,
    meta: {
      createdPerson: person,
      modifiedPerson: person,
      modifiedDate: version.modifiedDate,
    },
  });
  const find = (key: string | undefined): SyntheticPage | undefined =>
    key === undefined
      ? undefined
      : (pages.get(key) ??
        [...pages.values()].find((page) => page.title === key));

  const respond = (call: WriteCall): Response => {
    const path = call.url.pathname;
    const body: unknown =
      call.body === undefined ? undefined : JSON.parse(call.body);
    const fields = (
      typeof body === 'object' && body !== null ? body : {}
    ) as Record<string, unknown>;
    if (path === '/system/runtime/swagger/openapi.json') {
      return answer(options.document ?? specification);
    }
    if (path === '/api/info') {
      return answer({ version: '3.137.1', siteName: canaries.groupName });
    }
    if (path === '/api/wiki/categories' && call.method === 'GET') {
      return answer(
        options.categories ?? {
          data: [
            {
              id: identification,
              name: identificationCategoryName,
              nameTranslated: identificationCategoryName,
              permissions: { canEdit: false, canDelete: false },
            },
            {
              ...category,
              nameTranslated: canaries.groupName,
              permissions: { canEdit: true, canDelete: false },
            },
          ],
          meta: { count: 2 },
          permissions: { editMasterData: false },
        },
        options.categoriesStatus ?? 200,
      );
    }
    if (path === '/api/permissions/global') {
      return answer(
        options.rights ?? {
          data: {
            churchwiki: {
              view: true,
              'view category': [writeCategory, identification],
              'edit category': [writeCategory],
              'edit masterdata': false,
            },
            churchdb: { view: false, 'security level person': [] },
          },
        },
      );
    }
    const match =
      /^\/api\/wiki\/categories\/(\d+)\/pages(?:\/([^/]+)(\/versions(?:\/(\d+))?)?)?$/.exec(
        path,
      );
    if (match === null) {
      return error(404);
    }
    const [, requested, key, versions, version] = match;
    if (Number(requested) !== writeCategory) {
      return error(403);
    }
    if (key === undefined) {
      if (call.method === 'POST') {
        const title = fields['title'];
        if (typeof title !== 'string' || title === '') {
          return error(400);
        }
        if ([...pages.values()].some((page) => page.title === title)) {
          const status = options.duplicateStatus ?? 400;
          if (status !== 201) {
            return error(status);
          }
        }
        const text = fields['text'];
        const page: SyntheticPage = {
          guid: makeGuid(),
          title,
          onStartpage: fields['onStartpage'] === true,
          versions: [
            {
              version: 1,
              text: typeof text === 'string' ? text : null,
              isMarkdown: fields['isMarkdown'] === true,
              modifiedDate: now(),
            },
          ],
        };
        pages.set(page.guid, page);
        return answer({ data: pageData(page) }, 201);
      }
      const list = [...pages.values()].map(listEntry);
      return answer({ data: list, meta: { count: list.length } });
    }
    const page = call.method === 'GET' ? find(key) : pages.get(key);
    if (page === undefined) {
      return error(404);
    }
    if (call.method === 'DELETE') {
      if (page === autoPage) {
        return error(403);
      }
      const status = options.deleteStatus ?? 204;
      if (status === 204) {
        pages.delete(page.guid);
      }
      return status === 204 ? answer(null, 204) : error(status);
    }
    if (call.method === 'PATCH') {
      if (
        options.honourPreconditions === true &&
        (call.headers.has('if-match') ||
          call.headers.has('if-unmodified-since'))
      ) {
        return error(412);
      }
      const current = latest(page);
      let next: SyntheticVersion = { ...current, modifiedDate: now() };
      if (typeof fields['isMarkdown'] === 'boolean') {
        next = { ...next, isMarkdown: fields['isMarkdown'] };
      }
      if (typeof fields['onStartpage'] === 'boolean') {
        page.onStartpage = fields['onStartpage'];
      }
      const text = fields['text'];
      if (
        typeof text === 'string' &&
        (text !== current.text || options.sameTextNewVersion === true)
      ) {
        page.versions.push({ ...next, version: current.version + 1, text });
      } else {
        page.versions[page.versions.length - 1] = next;
      }
      if (options.honourTitle === true && typeof fields['title'] === 'string') {
        const renamed: SyntheticPage = { ...page, title: fields['title'] };
        pages.set(page.guid, renamed);
        return answer({ data: pageData(renamed) });
      }
      return answer({ data: pageData(page) });
    }
    if (versions === undefined) {
      return answer({ data: pageData(page) });
    }
    if (version === undefined) {
      return answer({
        data: page.versions.map((entry) => pageData(page, entry)),
        meta: { count: page.versions.length },
      });
    }
    const found = page.versions.find(
      (entry) => entry.version === Number(version),
    );
    return found === undefined
      ? error(404)
      : answer({ data: pageData(page, found) });
  };

  return {
    calls,
    pages,
    autoPage,
    editorSave: (guid, change) => {
      const page = pages.get(guid);
      if (page === undefined) {
        throw new Error('unknown page');
      }
      const current = latest(page);
      page.versions.push({
        ...current,
        version: current.version + 1,
        text: change(current.text ?? ''),
        modifiedDate: now(),
      });
    },
    fetch: (url, init) => {
      const call: WriteCall = {
        method: init.method ?? 'fehlt',
        url,
        headers: new Headers(init.headers),
        body: typeof init.body === 'string' ? init.body : undefined,
      };
      calls.push(call);
      if (options.failOnCall === calls.length) {
        return Promise.reject(
          new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }),
        );
      }
      return Promise.resolve(respond(call));
    },
  };
}
