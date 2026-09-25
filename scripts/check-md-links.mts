/**
 * Checks the relative links in all Markdown files of the repository.
 *
 * A relative link whose target does not exist is an error. Links to web
 * addresses and to anchors are not checked. brand/ is delivered as is and
 * skipped, like dependencies and build output.
 *
 * Usage: `node scripts/check-md-links.mts`
 *
 * @packageDocumentation
 */
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Folders that are not searched for Markdown files. */
export const skippedFolders: ReadonlySet<string> = new Set([
  'brand',
  'coverage',
  'dist',
  'node_modules',
]);

/**
 * Link targets that may be missing for now. TRADEMARKS.md follows after a
 * legal review, and the README already links to it.
 */
export const pendingTargets: ReadonlySet<string> = new Set(['TRADEMARKS.md']);

/** A link found in a Markdown text. */
export interface MarkdownLink {
  readonly line: number;
  readonly target: string;
}

/** A relative link whose target does not exist. */
export interface BrokenLink extends MarkdownLink {
  /** Path of the Markdown file, relative to the checked folder. */
  readonly file: string;
}

/** The result of checking a folder. */
export interface LinkReport {
  readonly files: number;
  readonly links: number;
  readonly broken: readonly BrokenLink[];
}

/**
 * Finds the link targets in a Markdown text.
 *
 * Covers inline links and images, reference definitions and the `href`,
 * `src` and `srcset` attributes of HTML elements. Code blocks and inline
 * code are left out, because links there are examples.
 *
 * @param markdown - Content of a Markdown file.
 * @returns The links with their line numbers, in order.
 */
export function extractLinks(markdown: string): MarkdownLink[] {
  // Code is replaced by spaces of the same length, so line numbers stay right.
  const blank = (code: string): string => code.replace(/[^\n]/g, ' ');
  const text = markdown
    .replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[^\n]*$/gm, blank)
    .replace(/`[^`\n]*`/g, blank);
  const links: MarkdownLink[] = [];
  const add = (index: number, target: string): void => {
    const line = text.slice(0, index).split('\n').length;
    links.push({ line, target: target.replace(/^<(.*)>$/, '$1') });
  };
  for (const match of text.matchAll(/\]\(\s*(<[^>\n]*>|[^\s)]+)/g)) {
    add(match.index, match[1] ?? '');
  }
  for (const match of text.matchAll(
    /^ {0,3}\[[^\]\n]+\]:\s*(<[^>\n]*>|\S+)/gm,
  )) {
    add(match.index, match[1] ?? '');
  }
  for (const match of text.matchAll(/\b(?:href|src)\s*=\s*["']([^"']+)["']/g)) {
    add(match.index, match[1] ?? '');
  }
  for (const match of text.matchAll(/\bsrcset\s*=\s*["']([^"']+)["']/g)) {
    for (const candidate of (match[1] ?? '').split(',')) {
      const url = candidate.trim().split(/\s+/)[0];
      if (url !== undefined && url !== '') {
        add(match.index, url);
      }
    }
  }
  return links.sort((a, b) => a.line - b.line);
}

/**
 * Tells whether a link target is a path in the repository.
 *
 * @param target - Link target as written in the Markdown file.
 * @returns False for web addresses, other schemes and anchors.
 */
export function isRelative(target: string): boolean {
  return (
    !/^[a-z][a-z0-9+.-]*:/i.test(target) &&
    !target.startsWith('#') &&
    !target.startsWith('//')
  );
}

async function markdownFiles(folder: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    // Hidden folders hold tool state and Git's own data, except .github.
    const hidden = entry.name.startsWith('.') && entry.name !== '.github';
    if (entry.isDirectory() && !hidden && !skippedFolders.has(entry.name)) {
      files.push(...(await markdownFiles(join(folder, entry.name))));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(join(folder, entry.name));
    }
  }
  return files;
}

/**
 * Checks all relative links in the Markdown files below a folder.
 *
 * A target starting with `/` counts from the checked folder, as on GitHub.
 * Anchors and query strings are ignored, only the file has to exist.
 *
 * @param root - Folder to check, usually the repository root.
 * @returns Counts and the links whose target does not exist.
 * @throws {Error} If a folder or file cannot be read.
 */
export async function checkLinks(root: string): Promise<LinkReport> {
  const files = (await markdownFiles(root)).sort();
  const broken: BrokenLink[] = [];
  let count = 0;
  for (const file of files) {
    for (const link of extractLinks(await readFile(file, 'utf8'))) {
      const path = link.target.split('#')[0]?.split('?')[0] ?? '';
      if (!isRelative(link.target) || path === '') {
        continue;
      }
      count++;
      let decoded = path;
      try {
        decoded = decodeURIComponent(path);
      } catch {
        // A malformed escape is checked as written.
      }
      const target = decoded.startsWith('/')
        ? join(root, decoded)
        : resolve(dirname(file), decoded);
      const fromRoot = relative(root, target).split(sep).join('/');
      if (!existsSync(target) && !pendingTargets.has(fromRoot)) {
        const name = relative(root, file).split(sep).join('/');
        broken.push({ file: name, line: link.line, target: link.target });
      }
    }
  }
  return { files: files.length, links: count, broken };
}

async function main(): Promise<number> {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const report = await checkLinks(root);
  for (const link of report.broken) {
    console.error(
      `Link ohne Ziel in ${link.file}, Zeile ${String(link.line)}: ${link.target}`,
    );
  }
  console.log(
    `Links geprüft: ${String(report.files)} Markdown-Dateien, ${String(report.links)} relative Links, ${String(report.broken.length)} ohne Ziel.`,
  );
  return report.broken.length === 0 ? 0 : 1;
}

if (import.meta.main) {
  process.exitCode = await main();
}
