/**
 * The schemas of the answers of ChurchTools that the client reads
 * (ADR 0025, ADR 0057). `z.object` drops unknown keys; no schema transforms
 * a value. They carry no data classes: what the tools pass on gets its
 * classes in the tool schemas.
 *
 * @packageDocumentation
 */
import { z } from 'zod';

const count = z.number().int().nonnegative();

/**
 * `meta.pagination` of a list with pages (`docs/research/churchtools-api.md`,
 * F6). `meta.all`, where it appears, is not read.
 */
export const paginationSchema = z.object({
  total: count,
  limit: count,
  current: count,
  lastPage: count,
});

/** `meta` of a list with pages. */
export const pagedMetaSchema = z.object({ pagination: paginationSchema });

/** `meta` of a list without pages, which only counts (F6). */
export const countedMetaSchema = z.object({ count });

// Whether a string has no lone surrogate, without String#isWellFormed,
// which the target of the compiler does not know.
const wellFormed = (text: string): boolean => {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
};

const text = (max: number) =>
  z.string().max(max, { abort: true }).refine(wellFormed);

const id = z.number().int().positive();

/**
 * The answer of `GET /api/whoami` (`docs/research/churchtools-api.md`,
 * F18), only the fields the client passes on. `meta.simulatingUserId` must
 * be null or missing; the check for the anonymous person runs before it.
 */
export const whoamiSchema = z.object({
  data: z.object({
    id,
    guid: z.string().min(1).max(64, { abort: true }).refine(wellFormed),
    firstName: text(255),
    lastName: text(255),
    email: text(254).nullable(),
  }),
  meta: z.object({ simulatingUserId: z.null().optional() }).optional(),
});

/** The value of one right: a boolean or a list of IDs (F5, F30). */
export const rightValueSchema = z.union([z.boolean(), z.array(id).max(10_000)]);
