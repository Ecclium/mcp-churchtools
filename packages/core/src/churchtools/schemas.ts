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
