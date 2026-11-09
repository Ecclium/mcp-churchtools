/**
 * The reader of YAML for every file of the configuration: the policy
 * (ADR 0032) and the routines (ADR 0033).
 *
 * Where it stands: at the start, while the configuration and the routines
 * are loaded. The reader of a file hands over the text it checked and
 * decoded, this module turns it into plain values, and the schema of the
 * file, such as `policy.v1` or `routine.v1`, checks those next. Planning
 * and committing a write later only see checked values.
 *
 * Why it is narrow: these files decide which targets a write may reach and
 * what a run reads and writes, so a feature of YAML that makes one text
 * mean two things has no place in them. The reader takes YAML 1.2 with
 * the schema `core` and exactly one
 * document, and refuses a key twice in one map, anchors and aliases, tags,
 * directives such as `%YAML 1.1`, keys that are not text and every
 * warning of the parser. Merge keys are off, so `<<` stays an unknown key
 * that the schema refuses.
 *
 * It is the only module that imports `yaml`, which a rule of
 * dependency-cruiser holds (place `configYaml`), so the policy, the
 * routines and every later file of the configuration share these limits.
 * The library writes the tokens it reads to stdout when the variable
 * `LOG_TOKENS` or `LOG_STREAM` is set, which would break the protocol over
 * stdio and put the content of a file on a stream; the loader of the
 * configuration refuses both while it names a file in YAML. Its warnings
 * go to no stream either, because the level of its log is `error`.
 *
 * @packageDocumentation
 */
import {
  isScalar,
  LineCounter,
  type ParsedNode,
  parseDocument,
  visit,
} from 'yaml';

// The prefix the handle `!!` stands for in YAML 1.2.
const defaultTagPrefix = 'tag:yaml.org,2002:';

/**
 * Why a text is no YAML a file of the configuration takes, frozen. A code
 * never carries a value of the file; the line, if known, travels beside
 * it. Each reader of a file turns it into a code of its own, such as
 * `policy_yaml_syntax`.
 */
export const configYamlCodes = Object.freeze([
  'yaml_syntax',
  'yaml_unsupported',
] as const);

/** Why a text is no YAML a file of the configuration takes. */
export type ConfigYamlCode = (typeof configYamlCodes)[number];

/** The plain values of the text, or why there are none. */
export type ConfigYamlResult =
  | { readonly ok: true; readonly value: unknown }
  | {
      readonly ok: false;
      readonly code: ConfigYamlCode;
      /** The line of the first problem, from 1, when the parser knows it. */
      readonly line?: number;
    };

// The options of the parser. The level `error` keeps the warnings out of
// every stream and still reports a second document as an error, which the
// level `silent` would not.
const options = Object.freeze({
  version: '1.2',
  schema: 'core',
  uniqueKeys: true,
  merge: false,
  strict: true,
  prettyErrors: false,
  logLevel: 'error',
} as const);

const refuse = (code: ConfigYamlCode, line?: number): ConfigYamlResult =>
  Object.freeze({
    __proto__: null,
    ok: false,
    code,
    ...(line === undefined ? {} : { line }),
  });

/**
 * Reads the text of a file of the configuration as YAML. JSON is YAML as
 * well, so a file in JSON reads the same way.
 *
 * @param text - The decoded text of the file.
 * @returns The plain values, or the code of the first problem with its
 *   line. It never throws for a text.
 * @throws {TypeError} When the text is not a string.
 * @example
 * ```ts
 * readConfigYaml('schema: policy.v1\n'); // { ok: true, value: { schema: 'policy.v1' } }
 * readConfigYaml('a: &x 1\nb: *x\n'); // { ok: false, code: 'yaml_unsupported', line: 1 }
 * ```
 */
export function readConfigYaml(text: string): ConfigYamlResult {
  if (typeof text !== 'string') {
    throw new TypeError('The text of the file must be a string.');
  }
  const lines = new LineCounter();
  const lineOf = (offset: number): number => lines.linePos(offset).line;
  try {
    const doc = parseDocument(text, { ...options, lineCounter: lines });
    // Errors first, then warnings such as a tag the schema does not know:
    // both mean the text is not what it seems.
    const [problem] = [...doc.errors, ...doc.warnings];
    if (problem !== undefined) {
      return refuse('yaml_syntax', lineOf(problem.pos[0]));
    }
    // A directive could change the version of YAML or what a tag means. The
    // document keeps no position of its directives, so there is no line.
    const { yaml: version, tags } = doc.directives;
    if (
      version.explicit === true ||
      Object.keys(tags).some(
        (handle) => handle !== '!!' || tags[handle] !== defaultTagPrefix,
      )
    ) {
      return refuse('yaml_unsupported');
    }
    let unsupported: number | undefined;
    // Every node of a document parsed from a text has its range. For an
    // anchor or a tag on a map or a list, that is the line where its first
    // entry starts, which may be one after the mark.
    const mark = (node: unknown): typeof visit.BREAK => {
      unsupported = lineOf((node as ParsedNode).range[0]);
      return visit.BREAK;
    };
    visit(doc, {
      Alias: (_key, node) => mark(node),
      Node: (_key, node) =>
        node.anchor === undefined && node.tag === undefined
          ? undefined
          : mark(node),
      Pair: (_key, pair) =>
        isScalar(pair.key) && typeof pair.key.value === 'string'
          ? undefined
          : mark(pair.key),
    });
    if (unsupported !== undefined) {
      return refuse('yaml_unsupported', unsupported);
    }
    const value: unknown = doc.toJS({ maxAliasCount: 0 });
    return Object.freeze({ __proto__: null, ok: true, value });
  } catch {
    // Such as a stack too deep for a text nested without end.
    return refuse('yaml_syntax');
  }
}
