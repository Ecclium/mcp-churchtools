/**
 * The writes of the ChurchTools client for the wiki (ADR 0072): create a
 * page in Markdown, change the text of a page, and read a page together
 * with the time of ChurchTools.
 *
 * Where they stand in the way of a write: a tool only plans; the write
 * guard of the core seals the plan, gets it confirmed and commits it
 * (ADR 0029). On the commit it reads the page with `wikiPageState` right
 * before writing, compares version and time, writes with `createWikiPage`
 * or `updateWikiPage`, and reads again right after to see that its version
 * follows. Nothing here decides whether a write may happen, and nothing
 * here retries: after any failure that follows the transport, ChurchTools
 * may have written, and only the read afterwards tells.
 *
 * The client never deletes a page of the wiki, and it writes only Markdown.
 *
 * @packageDocumentation
 */
import {
  EccliumError,
  isWikiPageGuid,
  maxWikiTitleLength,
  type TenantContext,
  type WikiPage,
} from '@ecclium/mcp-churchtools-plugin-api';

import { urlOfPath } from './query.js';
import { type RequestPath, sendWrite } from './request.js';
import {
  maxWikiWriteBytes,
  wellFormed,
  wikiPageCreatedSchema,
} from './schemas.js';
import { serverTimeOf } from './server-date.js';

/** A page the client created, as ChurchTools gave it back (F16). */
export interface CreatedWikiPage {
  /** The GUID of the new page, the only way to address it later. */
  readonly guid: string;
  /** The title as ChurchTools stored it. */
  readonly title: string;
  /** The version of the new page; the probes always saw 1 (F10). */
  readonly version: number;
  /** Whether ChurchTools made it a Markdown page; it should always be. */
  readonly isMarkdown: boolean;
}

/** A page as a plan reads it right before and right after a write. */
export interface WikiPageState {
  /** The page with title, format, version and text. */
  readonly page: WikiPage;
  /**
   * The time of ChurchTools from the `date` header of the answer, in
   * milliseconds since the Unix epoch, or null when the header is missing
   * or has another form. The write guard does not write without it.
   */
  readonly serverTime: number | null;
}

/** How the client reads a page for the writes: the page and its `date`. */
export type ReadWikiPage = (
  ctx: TenantContext,
  categoryId: number,
  guid: string,
) => Promise<{ readonly page: WikiPage; readonly date: string | undefined }>;

/**
 * The writes of the client and the read a plan needs (ADR 0072). Only the
 * write guard of the core is to call them; tools reach ChurchTools through
 * the pipeline and never see the client (ADR 0024).
 */
export interface ChurchToolsWrites {
  /**
   * Creates a Markdown page with `POST /api/wiki/categories/{id}/pages`,
   * sending exactly `title`, `text` and `isMarkdown: true`.
   *
   * @throws {EccliumError} `validation` for a value it may not send,
   *   `conflict` when a page of the category may already have the title,
   *   `not_found` for a category that does not exist, and the codes of
   *   every other failure.
   */
  createWikiPage(
    ctx: TenantContext,
    categoryId: number,
    title: string,
    text: string,
  ): Promise<CreatedWikiPage>;
  /**
   * Replaces the text of a page with `PATCH …/pages/{guid}`, sending
   * exactly `text`. The answer is not read; read the page again to see
   * that the version rose.
   *
   * @throws {EccliumError} `validation` for a value it may not send,
   *   `not_found` for a page or category that does not exist, and the
   *   codes of every other failure.
   */
  updateWikiPage(
    ctx: TenantContext,
    categoryId: number,
    guid: string,
    text: string,
  ): Promise<void>;
  /**
   * Reads a page in its newest version with the time of ChurchTools, for
   * the read right before and right after a write.
   *
   * @throws {EccliumError} As the read of a page.
   */
  wikiPageState(
    ctx: TenantContext,
    categoryId: number,
    guid: string,
  ): Promise<WikiPageState>;
}

/** What the writes are built from. */
export interface WikiWritesOptions {
  /** Origin, transport and throttle, the same as for every read. */
  readonly path: RequestPath;
  /** The canonical origin of the client. */
  readonly origin: string;
  /** The read of a page that the client uses itself. */
  readonly readPage: ReadWikiPage;
}

// The answer of a write carries the page with its text; it stays within
// the limits of reading one page.
const wikiWriteLimits = Object.freeze({
  maxResponseBytes: 4 * 1024 * 1024,
  maxElements: 20_000,
});

const invalidWikiWriteInput = `A category ID is a whole number from 1 and a page is addressed by its GUID. A title has 1 to ${String(maxWikiTitleLength)} characters, no control characters and no spaces at either end. A text has 1 byte to ${String(maxWikiWriteBytes / 1024)} KiB in UTF-8 and no character U+0000.`;

// ChurchTools refuses a second page with the title of one in the same
// category with 400 (F8, «Titel einer Seite»). The client cannot read the
// cause, because it never reads the body of an error, so the sentence says
// what is likely.
const duplicateTitle =
  'ChurchTools refused the new page. A page with this title may already exist in the category: choose another title, or change that page instead.';

const isWholeFromOne = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;

// A title fits when ChurchTools stores it as sent: no control character of
// C0, C1 or DEL, no space at either end that it might trim, and no lone
// surrogate.
const isTitle = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  if (value.length < 1 || value.length > maxWikiTitleLength) return false;
  if (value.trim() !== value || !wellFormed(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return false;
  }
  return true;
};

// A text fits when it has 1 byte to the limit in UTF-8, no lone surrogate
// and no U+0000, which a database may cut a text at. A string longer than
// the limit in UTF-16 units is longer in bytes as well, so it is refused
// before it is encoded.
const isText = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length >= 1 &&
  value.length <= maxWikiWriteBytes &&
  wellFormed(value) &&
  !value.includes('\u0000') &&
  new TextEncoder().encode(value).byteLength <= maxWikiWriteBytes;

// The body of a write, as JSON in UTF-8.
const jsonBody = (value: Readonly<Record<string, unknown>>): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(value));

/**
 * Builds the writes of one client, on its path and under its throttle.
 *
 * @param options - Path, origin and the read of a page of the client.
 * @returns The writes, frozen.
 * @example
 * ```ts
 * const writes = createWikiWrites({ path, origin, readPage });
 * const created = await writes.createWikiPage(ctx, 4, 'Dienstplan', '# Dienstplan');
 * ```
 */
export function createWikiWrites(
  options: WikiWritesOptions,
): ChurchToolsWrites {
  const { path, origin, readPage } = options;

  // Refuses what may not be sent before the tenant is checked and the
  // throttle gives a place, so that an invalid value costs no request.
  const checkInput = (ctx: TenantContext, valid: boolean): void => {
    if (valid) return;
    ctx.log.warn('churchtools_wiki_write_input_refused', {
      code: 'validation',
    });
    throw new EccliumError('validation', invalidWikiWriteInput);
  };

  const createWikiPage = async (
    ctx: TenantContext,
    categoryId: number,
    title: string,
    text: string,
  ): Promise<CreatedWikiPage> => {
    checkInput(
      ctx,
      isWholeFromOne(categoryId) && isTitle(title) && isText(text),
    );
    const url = urlOfPath(
      origin,
      `/api/wiki/categories/${String(categoryId)}/pages`,
    );
    const root = await sendWrite(
      ctx,
      path,
      {
        method: 'POST',
        url,
        body: jsonBody({ title, text, isMarkdown: true }),
        success: 201,
        refused: 'churchtools_wiki_page_create_refused',
        badRequest: { code: 'conflict', message: duplicateTitle },
      },
      wikiWriteLimits,
      {
        status: 'churchtools_wiki_page_create_status',
        missing: 'churchtools_wiki_page_create_missing',
      },
    );
    // The page exists once ChurchTools answered 201. An answer without a
    // GUID in its form leaves it unaddressed, so it is an error; a title or
    // format other than sent is given back for the write guard to judge.
    const parsed = wikiPageCreatedSchema.safeParse(root);
    if (!parsed.success) {
      ctx.log.warn('churchtools_wiki_page_create_refused', {
        code: 'upstream',
      });
      throw new EccliumError('upstream');
    }
    const data = parsed.data.data;
    return Object.freeze({
      __proto__: null,
      guid: data.guid,
      title: data.title,
      version: data.version,
      isMarkdown: data.isMarkdown,
    });
  };

  const updateWikiPage = async (
    ctx: TenantContext,
    categoryId: number,
    guid: string,
    text: string,
  ): Promise<void> => {
    checkInput(
      ctx,
      isWholeFromOne(categoryId) && isWikiPageGuid(guid) && isText(text),
    );
    const url = urlOfPath(
      origin,
      `/api/wiki/categories/${String(categoryId)}/pages/${guid}`,
    );
    await sendWrite(
      ctx,
      path,
      { method: 'PATCH', url, body: jsonBody({ text }), success: 200 },
      wikiWriteLimits,
      {
        status: 'churchtools_wiki_page_update_status',
        missing: 'churchtools_wiki_page_update_missing',
      },
    );
  };

  const wikiPageState = async (
    ctx: TenantContext,
    categoryId: number,
    guid: string,
  ): Promise<WikiPageState> => {
    const { page, date } = await readPage(ctx, categoryId, guid);
    return Object.freeze({
      __proto__: null,
      page,
      serverTime: serverTimeOf(date),
    });
  };

  return Object.freeze({ createWikiPage, updateWikiPage, wikiPageState });
}
