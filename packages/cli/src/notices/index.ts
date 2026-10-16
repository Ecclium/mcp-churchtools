/**
 * The start notices of the command line, the one place of the command line
 * besides the output module that writes to stderr (ADR 0053, ADR 0055).
 * The start over stdio may reach it, because it never writes to stdout.
 *
 * @packageDocumentation
 */
export {
  maxNoticeLength,
  type NoticeOptions,
  type NoticeResult,
  writeNotices,
} from './notices.js';
