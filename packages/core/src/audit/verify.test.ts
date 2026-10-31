import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { createLogger, maxLineLength } from '../logger/index.js';
import { openAuditFile } from './file-writer.js';
import { type AuditFolder, type AuditLine, openAuditFolder } from './reader.js';
import {
  type AuditAnchor,
  type AuditAnchorSet,
  anchorOfLogLine,
  auditFindingKinds,
  createAnchorCollector,
  maxAnchors,
  maxFindings,
  maxLogLineLength,
  verifyAuditFiles,
} from './verify.js';

const sha256 = (text: string): string =>
  createHash('sha256').update(text).digest('hex');

const nameOf = (number: number, day = '2026-10-31'): string =>
  `audit-${day}-120000-4242-${String(number)}.jsonl`;

const clock = { now: () => Date.UTC(2026, 9, 31, 15, 0, 0) };

/**
 * The whole lines of a file as the writer chains them: the line it gets,
 * with seq and prevHash before the last brace.
 */
const chain = (name: string, count: number, first = 1): string[] => {
  const lines: string[] = [];
  let previous = sha256(name);
  for (let seq = first; seq < first + count; seq += 1) {
    const line = `{"v":1,"n":${String(seq)},"seq":${String(seq)},"prevHash":"${previous}"}`;
    lines.push(line);
    previous = sha256(line);
  }
  return lines;
};

const anchorOf = (name: string, lines: readonly string[]): AuditAnchor => {
  const last = lines.at(-1) ?? '';
  return {
    file: name,
    seq: (JSON.parse(last) as { seq: number }).seq,
    hash: sha256(last),
  };
};

const isShown = (text: string): boolean => /^[ -~]*$/.test(text);

/** The lines of a text as the reader gives them. */
const linesOf = (text: string): AuditLine[] =>
  text
    .split('\n')
    .slice(0, -1)
    .map((line, index) => ({
      number: index + 1,
      hash: sha256(line),
      text: isShown(line) && line.length <= maxLineLength ? line : undefined,
      tooLong: line.length > maxLineLength,
      piece: line.endsWith('~'),
    }));

/**
 * A folder with files of text, and files whose value is the outcome of
 * reading them: gone, unsafe, unreadable, moved or read without lines.
 */
const folderOf = (
  files: Readonly<Record<string, string>>,
  others = 0,
): AuditFolder => ({
  names: Object.keys(files).sort(),
  others,
  read: (name, onLine) => {
    const file = files[name];
    if (file === undefined) return 'gone';
    if (
      file === 'gone' ||
      file === 'unsafe' ||
      file === 'unreadable' ||
      file === 'moved'
    ) {
      return file;
    }
    if (file === 'read') return 'read';
    for (const line of linesOf(file)) onLine(line);
    return 'read';
  },
});

const textOf = (lines: readonly string[]): string =>
  lines.map((line) => `${line}\n`).join('');

const anchorSet = (
  anchors: readonly AuditAnchor[],
  conflicts: readonly string[] = [],
): AuditAnchorSet => ({
  anchors: new Map(anchors.map((anchor) => [anchor.file, anchor])),
  conflicts,
  dropped: 0,
});

const verify = (
  folder: AuditFolder,
  anchors?: AuditAnchorSet,
  retentionMonths = 12,
) => verifyAuditFiles({ folder, anchors, retentionMonths, clock });

describe('verifyAuditFiles and the chain', () => {
  const name = nameOf(1);
  const lines = chain(name, 5);

  it('finds nothing in a whole chain and counts files and lines', () => {
    const report = verify(folderOf({ [name]: textOf(lines) }, 2));

    expect(report).toEqual({
      files: 1,
      checked: 1,
      unchained: 0,
      lines: 5,
      others: 2,
      vanished: 0,
      anchors: 0,
      anchorsMatched: 0,
      anchorsExpired: 0,
      findings: [],
      findingsOmitted: 0,
    });
    expect(Object.isFrozen(report)).toBe(true);
  });

  it('finds a changed line at the link to the next line', () => {
    const changed = [...lines];
    changed[1] = (changed[1] ?? '').replace('"n":2', '"n":9');

    expect(verify(folderOf({ [name]: textOf(changed) })).findings).toEqual([
      { kind: 'chain_link', file: name, line: 3 },
    ]);
  });

  it('finds a removed, an added and a swapped line', () => {
    const removed = lines.filter((_, index) => index !== 2);
    const added = [...lines.slice(0, 2), lines[1] ?? '', ...lines.slice(2)];
    const swapped = [lines[0], lines[2], lines[1], lines[3], lines[4]].map(
      (line) => line ?? '',
    );

    expect(verify(folderOf({ [name]: textOf(removed) })).findings).toEqual([
      { kind: 'chain_link', file: name, line: 3 },
    ]);
    // The added copy of line 2 breaks the link; line 4 links to it again.
    expect(verify(folderOf({ [name]: textOf(added) })).findings).toEqual([
      { kind: 'chain_link', file: name, line: 3 },
    ]);
    expect(verify(folderOf({ [name]: textOf(swapped) })).findings).toEqual([
      { kind: 'chain_link', file: name, line: 2 },
      { kind: 'chain_link', file: name, line: 3 },
      { kind: 'chain_link', file: name, line: 4 },
    ]);
  });

  it('finds a renamed or swapped file at its first line', () => {
    const other = nameOf(2);

    expect(verify(folderOf({ [other]: textOf(lines) })).findings).toEqual([
      { kind: 'chain_name', file: other, line: 1 },
    ]);
  });

  it('finds a seq that does not follow on a whole link', () => {
    const jumped = chain(name, 2);
    const third = `{"v":1,"n":3,"seq":4,"prevHash":"${sha256(jumped[1] ?? '')}"}`;
    const fourth = `{"v":1,"n":4,"seq":5,"prevHash":"${sha256(third)}"}`;

    expect(
      verify(folderOf({ [name]: textOf([...jumped, third, fourth]) })).findings,
    ).toEqual([{ kind: 'chain_seq', file: name, line: 3 }]);
  });

  it('leaves pieces out of the chain', () => {
    const withPieces = [
      'x~',
      lines[0] ?? '',
      '{"v":1,"half~',
      ...lines.slice(1),
    ];

    const report = verify(folderOf({ [name]: textOf(withPieces) }));

    expect(report.findings).toEqual([]);
    expect(report.lines).toBe(5);
  });

  it('finds lines of another form and goes on from them', () => {
    const forms = [
      'not json',
      '[1,2]',
      'null',
      '{"v":1,"seq":0,"prevHash":"x"}',
    ];
    for (const form of forms) {
      const first = lines[0] ?? '';
      const second = `{"v":1,"n":2,"seq":3,"prevHash":"${sha256(form)}"}`;
      expect(
        verify(folderOf({ [name]: textOf([first, form, second]) })).findings,
      ).toEqual([{ kind: 'line_form', file: name, line: 2 }]);
    }
  });

  it('finds a chain field of another form in a chained file', () => {
    const first = lines[0] ?? '';
    for (const link of [
      `"seq":0,"prevHash":"${sha256(first)}"`,
      `"seq":"2","prevHash":"${sha256(first)}"`,
      `"seq":1.5,"prevHash":"${sha256(first)}"`,
      `"seq":2,"prevHash":"${sha256(first).toUpperCase()}"`,
      `"seq":2`,
      `"prevHash":"${sha256(first)}"`,
    ]) {
      const second = `{"v":1,${link}}`;
      expect(
        verify(folderOf({ [name]: textOf([first, second]) })).findings,
      ).toEqual([{ kind: 'line_form', file: name, line: 2 }]);
    }
  });

  it('finds bytes outside printable ASCII and a line that is too long', () => {
    const first = lines[0] ?? '';
    const strange = `${first.slice(0, -1)},"x":"ä"}`;
    const long = `{"x":"${'a'.repeat(maxLineLength)}"}`;

    expect(
      verify(folderOf({ [name]: textOf([strange, long]) })).findings,
    ).toEqual([
      { kind: 'line_form', file: name, line: 1 },
      { kind: 'line_too_long', file: name, line: 2 },
    ]);
  });

  it('counts a file without a chain and finds none', () => {
    const plain = textOf(['{"v":1,"n":1}', '{"v":1,"n":2}']);

    const report = verify(folderOf({ [name]: plain }));

    expect(report.unchained).toBe(1);
    expect(report.findings).toEqual([]);
  });

  it('finds a chain in only a part of the lines', () => {
    const first = lines[0] ?? '';
    const mixedAfter = textOf([first, '{"v":1,"n":2}']);
    const mixedBefore = textOf([
      '{"v":1,"n":1}',
      `{"v":1,"seq":2,"prevHash":"${sha256('{"v":1,"n":1}')}"}`,
    ]);

    expect(verify(folderOf({ [name]: mixedAfter })).findings).toEqual([
      { kind: 'chain_mixed', file: name, line: 2 },
    ]);
    expect(verify(folderOf({ [name]: mixedBefore })).findings).toEqual([
      { kind: 'chain_mixed', file: name, line: 2 },
    ]);
  });

  it('decides on the chain at the first line that is an object', () => {
    const first = 'not json';
    const second = `{"v":1,"seq":2,"prevHash":"${sha256(first)}"}`;

    const report = verify(folderOf({ [name]: textOf([first, second]) }));

    expect(report.findings).toEqual([
      { kind: 'line_form', file: name, line: 1 },
    ]);
    expect(report.unchained).toBe(0);
  });

  it('throws without a retention or a clock', () => {
    const folder = folderOf({});
    for (const retentionMonths of [0, 121, 1.5, Number.NaN]) {
      expect(() =>
        verifyAuditFiles({ folder, retentionMonths, clock }),
      ).toThrow(TypeError);
    }
    expect(() =>
      verifyAuditFiles({
        folder,
        retentionMonths: 12,
        clock: {} as typeof clock,
      }),
    ).toThrow(TypeError);
  });
});

describe('verifyAuditFiles and the anchors', () => {
  const name = nameOf(1);
  const lines = chain(name, 4);
  const anchor = anchorOf(name, lines);

  it('matches a file that ends with the line of its anchor', () => {
    const report = verify(
      folderOf({ [name]: textOf(lines) }),
      anchorSet([anchor]),
    );

    expect(report.anchors).toBe(1);
    expect(report.anchorsMatched).toBe(1);
    expect(report.findings).toEqual([]);
  });

  it('finds a changed last line only with its anchor', () => {
    const changed = [...lines];
    changed[3] = (changed[3] ?? '').replace('"n":4', '"n":7');

    expect(verify(folderOf({ [name]: textOf(changed) })).findings).toEqual([]);
    expect(
      verify(folderOf({ [name]: textOf(changed) }), anchorSet([anchor]))
        .findings,
    ).toEqual([{ kind: 'anchor_mismatch', file: name }]);
  });

  it('finds a file cut before the line of its anchor', () => {
    const cut = `${textOf(lines.slice(0, 3))}${(lines[3] ?? '').slice(0, 20)}`;

    for (const text of [textOf(lines.slice(0, 3)), cut, '']) {
      expect(
        verify(folderOf({ [name]: text }), anchorSet([anchor])).findings,
      ).toEqual([{ kind: 'anchor_truncated', file: name }]);
    }
  });

  it('finds whole lines after the line of its anchor', () => {
    const longer = chain(name, 5);

    expect(
      verify(folderOf({ [name]: textOf(longer) }), anchorSet([anchor]))
        .findings,
    ).toEqual([{ kind: 'anchor_extended', file: name }]);
  });

  it('finds a file whose lines carry other numbers or no chain', () => {
    const renumbered = chain(name, 5, 2).slice(0, 4);
    const plain = textOf(['{"v":1,"n":1}', '{"v":1,"n":2}']);
    const broken = textOf(['not json']);

    for (const text of [textOf(renumbered), plain, broken]) {
      const report = verify(folderOf({ [name]: text }), anchorSet([anchor]));
      expect(report.findings).toContainEqual({
        kind: 'anchor_mismatch',
        file: name,
      });
    }
  });

  it('finds the anchor of a missing file within its retention', () => {
    const recent = nameOf(1, '2026-10-01');
    const old = nameOf(1, '2025-10-30');
    const impossible = 'audit-2026-02-30-120000-4242-1.jsonl';
    const report = verify(
      folderOf({}),
      anchorSet([
        { ...anchor, file: recent },
        { ...anchor, file: old },
        { ...anchor, file: impossible },
      ]),
    );

    expect(report.anchorsExpired).toBe(1);
    expect(report.findings).toEqual([
      { kind: 'file_missing', file: impossible },
      { kind: 'file_missing', file: recent },
    ]);
  });

  it('counts the anchor of a file past a short retention as expired', () => {
    const lastMonth = nameOf(1, '2026-09-30');

    expect(
      verify(folderOf({}), anchorSet([{ ...anchor, file: lastMonth }]), 1)
        .anchorsExpired,
    ).toBe(1);
  });

  it('finds every missing file when the clock fails', () => {
    const old = nameOf(1, '2020-01-01');
    const report = verifyAuditFiles({
      folder: folderOf({}),
      anchors: anchorSet([{ ...anchor, file: old }]),
      retentionMonths: 12,
      clock: {
        now: () => {
          throw new Error('clock');
        },
      },
    });

    expect(report.findings).toEqual([{ kind: 'file_missing', file: old }]);
  });

  it('reports a conflict of anchors and compares no anchor for it', () => {
    const report = verify(
      folderOf({ [name]: textOf(lines) }),
      anchorSet([], [name]),
    );

    expect(report.findings).toEqual([{ kind: 'anchor_conflict', file: name }]);
    expect(report.anchorsMatched).toBe(0);
  });
});

describe('verifyAuditFiles and files it cannot read', () => {
  const lines = chain(nameOf(1), 2);

  it('tells each outcome apart', () => {
    const report = verify(
      folderOf({
        [nameOf(1)]: textOf(lines),
        [nameOf(2)]: 'gone',
        [nameOf(3)]: 'unsafe',
        [nameOf(4)]: 'unreadable',
        [nameOf(5)]: 'gone',
      }),
      anchorSet([
        { file: nameOf(2), seq: 1, hash: sha256('x') },
        { file: nameOf(3), seq: 1, hash: sha256('x') },
        { file: nameOf(4), seq: 1, hash: sha256('x') },
        { file: nameOf(1, '2020-01-01'), seq: 1, hash: sha256('x') },
      ]),
    );

    expect(report.checked).toBe(1);
    expect(report.vanished).toBe(2);
    expect(report.anchorsExpired).toBe(1);
    expect(report.findings).toEqual([
      { kind: 'file_missing', file: nameOf(2) },
      { kind: 'file_unsafe', file: nameOf(3) },
      { kind: 'file_unreadable', file: nameOf(4) },
    ]);
  });

  it('counts an expired file that went during the check', () => {
    const old = nameOf(1, '2020-01-01');

    const report = verify(
      folderOf({ [old]: 'gone' }),
      anchorSet([{ file: old, seq: 1, hash: sha256('x') }]),
    );

    expect(report.anchorsExpired).toBe(1);
    expect(report.findings).toEqual([]);
  });

  it('stops when the folder moves and judges no missing file then', () => {
    const report = verify(
      folderOf({ [nameOf(1)]: 'moved', [nameOf(2)]: textOf(lines) }),
      anchorSet([{ file: nameOf(3), seq: 1, hash: sha256('x') }]),
    );

    expect(report.checked).toBe(0);
    expect(report.findings).toEqual([
      { kind: 'folder_moved', file: nameOf(1) },
    ]);
  });

  it('lists the first findings and counts the others', () => {
    const name = nameOf(1);
    const broken = Array.from({ length: maxFindings + 50 }, () => 'x');

    const report = verify(folderOf({ [name]: textOf(broken) }));

    expect(report.findings).toHaveLength(maxFindings);
    expect(report.findingsOmitted).toBe(50);
    expect(Object.isFrozen(report.findings[0])).toBe(true);
  });

  it('checks an empty file and a file read without lines', () => {
    const report = verify(folderOf({ [nameOf(1)]: '', [nameOf(2)]: 'read' }));

    expect(report.checked).toBe(2);
    expect(report.unchained).toBe(0);
    expect(report.findings).toEqual([]);
  });

  it('knows its kinds of finding', () => {
    expect(auditFindingKinds).toHaveLength(14);
    expect(Object.isFrozen(auditFindingKinds)).toBe(true);
  });
});

describe('anchorOfLogLine', () => {
  const file = nameOf(1);
  const hash = sha256('x');
  const line = `{"ts":"2026-10-31T12:00:00.000Z","level":"info","event":"audit_chain_anchor","file":"${file}","seq":3,"hash":"${hash}"}`;

  it('reads an anchor, also after a prefix and before trailing text', () => {
    for (const text of [
      line,
      `2026-10-31T12:00:00.000Z [ecclium] [error] ${line}`,
      `${line}\r`,
      `prefix ${line} suffix`,
    ]) {
      expect(anchorOfLogLine(text)).toEqual({ file, seq: 3, hash });
    }
    expect(Object.isFrozen(anchorOfLogLine(line))).toBe(true);
  });

  it('skips every other line', () => {
    for (const text of [
      '',
      'no json',
      '{"ts":"2026-10-31T12:00:00.000Z"',
      line.replace('audit_chain_anchor', 'audit_file_closed'),
      line.replace(file, 'audit-2026-10-31.jsonl'),
      line.replace('"seq":3', '"seq":0'),
      line.replace('"seq":3', '"seq":"3"'),
      line.replace(hash, hash.toUpperCase()),
      line.replace('"ts":', '"tz":'),
      JSON.stringify({ message: line }),
      line.slice(0, -1),
      `{"ts":"x"} ${'x'.repeat(maxLogLineLength)}`,
      42 as unknown as string,
    ]) {
      expect(anchorOfLogLine(text)).toBeUndefined();
    }
  });
});

describe('createAnchorCollector', () => {
  const lineOf = (file: string, seq: number, hash: string): string =>
    `{"ts":"2026-10-31T12:00:00.000Z","level":"info","event":"audit_chain_anchor","file":"${file}","seq":${String(seq)},"hash":"${hash}"}`;

  it('takes each anchor once and sets aside files with two', () => {
    const collector = createAnchorCollector();

    expect(collector.add(lineOf(nameOf(1), 2, sha256('a')))).toBe(true);
    expect(collector.add(lineOf(nameOf(1), 2, sha256('a')))).toBe(true);
    expect(collector.add('{"ts":"x","event":"other"}')).toBe(false);
    collector.add(lineOf(nameOf(2), 2, sha256('a')));
    collector.add(lineOf(nameOf(2), 3, sha256('a')));
    collector.add(lineOf(nameOf(3), 1, sha256('a')));
    collector.add(lineOf(nameOf(3), 1, sha256('b')));
    collector.add(lineOf(nameOf(3), 1, sha256('c')));

    const result = collector.result();
    expect([...result.anchors.keys()]).toEqual([nameOf(1)]);
    expect(result.conflicts).toEqual([nameOf(2), nameOf(3)]);
    expect(result.dropped).toBe(0);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('counts the anchors beyond the most files it keeps', () => {
    const collector = createAnchorCollector();
    const hash = sha256('a');
    for (let number = 1; number <= maxAnchors + 2; number += 1) {
      collector.add(lineOf(nameOf(number), 1, hash));
    }

    const result = collector.result();
    expect(result.anchors.size).toBe(maxAnchors);
    expect(result.dropped).toBe(2);
  }, 120_000);
});

describe('verifyAuditFiles with the writer and the reader', () => {
  const base = mkdtempSync(join(tmpdir(), 'ecclium-audit-verify-'));
  const stateDir = join(base, 'state');
  mkdirSync(stateDir, { mode: 0o700 });
  chmodSync(stateDir, 0o700);

  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });

  // The files and the anchor as the server writes them: the writer of the
  // audit file and the logger with anchors.
  const write = (pid: number): string[] => {
    const log: string[] = [];
    const logger = createLogger({
      writer: { write: (line) => log.push(line) > 0 },
      clock,
      minLevel: 'info',
      anchors: true,
    });
    const opened = openAuditFile({ stateDir, clock, pid, retentionMonths: 12 });
    if (!opened.ok) throw new Error(opened.code);
    opened.writer.attach({
      anchor: ({ file, seq, hash }) => {
        logger.info('audit_chain_anchor', { file, seq, hash });
      },
      swept: () => undefined,
    });
    for (let index = 1; index <= 3; index += 1) {
      opened.writer.write(`{"v":1,"pid":${String(pid)},"n":${String(index)}}`);
    }
    opened.writer.close();
    return log;
  };

  it('finds nothing in the files of two processes with their anchors', () => {
    const log = [...write(101), ...write(102)];
    const collector = createAnchorCollector();
    for (const line of log) collector.add(line);
    const opened = openAuditFolder({ stateDir });
    if (!opened.ok) throw new Error(opened.code);

    const report = verifyAuditFiles({
      folder: opened.folder,
      anchors: collector.result(),
      retentionMonths: 12,
      clock,
    });

    expect(report).toMatchObject({
      files: 2,
      checked: 2,
      lines: 6,
      anchors: 2,
      anchorsMatched: 2,
      findings: [],
    });
  });

  it('finds a changed byte and a forged anchor in these files', () => {
    const opened = openAuditFolder({ stateDir });
    if (!opened.ok) throw new Error(opened.code);
    const [first = '', second = ''] = opened.folder.names;
    const path = join(stateDir, 'audit', first);
    const text = readFileSync(path, 'latin1');
    writeFileSync(path, text.replace('"n":2', '"n":5'), 'latin1');
    const collector = createAnchorCollector();
    collector.add(
      `{"ts":"2026-10-31T15:00:00.000Z","level":"info","event":"audit_chain_anchor","file":"${second}","seq":3,"hash":"${sha256('forged')}"}`,
    );

    const report = verifyAuditFiles({
      folder: opened.folder,
      anchors: collector.result(),
      retentionMonths: 12,
      clock,
    });

    expect(report.findings).toEqual([
      { kind: 'chain_link', file: first, line: 3 },
      { kind: 'anchor_mismatch', file: second },
    ]);
  });
});
