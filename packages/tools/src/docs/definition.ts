/**
 * Writes the definition of an operation as text: description, tags,
 * parameters, request body and answers, one line for each field with an
 * indent for its depth.
 *
 * Text, not structured output, for two reasons. A schema of the facts is
 * recursive, and the registry refuses a recursive output schema (ADR
 * 0024). And as JSON the largest operation of ChurchTools 3.138 would
 * break the limit of 64 KiB of a result, while a long text can come in
 * parts like the text of a wiki page (ADR 0066). The text is foreign
 * content from the OpenAPI document and stands in the data envelope.
 *
 * @packageDocumentation
 */
import type {
  OperationContent,
  OperationFact,
  Shape,
} from '@ecclium/mcp-churchtools-docs-index';

const indent = (depth: number): string => '  '.repeat(depth);

// A description of a field on one line: the document writes some over
// several lines, which would break the indent that shows the depth.
const oneLine = (text: string): string => text.replace(/\s+/gu, ' ').trim();

/**
 * The head of a schema on one line: its types, format, name under
 * `components`, allowed values and description, such as
 * `integer, format int64. ID of group`.
 *
 * @param shape - The schema.
 * @returns The line, `any` for a schema that says nothing.
 * @example
 * ```ts
 * shapeHead({ type: ['string'], enum: ['ASC', 'DESC'] });
 * // 'string, one of "ASC", "DESC"'
 * ```
 */
export function shapeHead(shape: Shape): string {
  const parts: string[] = [];
  if (shape.type !== undefined) parts.push(shape.type.join(' or '));
  if (shape.format !== undefined) parts.push(`format ${shape.format}`);
  if (shape.ref !== undefined) parts.push(`schema ${shape.ref}`);
  if (shape.enum !== undefined) {
    parts.push(
      `one of ${shape.enum.map((value) => JSON.stringify(value)).join(', ')}`,
    );
  }
  const head = parts.length === 0 ? 'any' : parts.join(', ');
  return shape.description === undefined
    ? head
    : `${head}. ${oneLine(shape.description)}`;
}

/**
 * The lines below the head of a schema: its properties, the elements of
 * an array, further properties of an object and the parts of `anyOf`,
 * `oneOf` and `allOf`, each with the lines below it.
 *
 * @param shape - The schema.
 * @param depth - The indent of the lines, in steps of two spaces.
 * @returns The lines, none for a schema without parts.
 * @example
 * ```ts
 * shapeLines({ type: ['array'], items: { type: ['integer'] } }, 1);
 * // ['  - items: integer']
 * ```
 */
export function shapeLines(shape: Shape, depth: number): string[] {
  const lines: string[] = [];
  const pad = indent(depth);
  const nested = (label: string, inner: Shape) => {
    lines.push(`${pad}- ${label}: ${shapeHead(inner)}`);
    lines.push(...shapeLines(inner, depth + 1));
  };
  for (const property of shape.properties ?? []) {
    nested(
      property.required ? `${property.name} (required)` : property.name,
      property.schema,
    );
  }
  if (shape.items !== undefined) nested('items', shape.items);
  if (shape.additionalProperties === true) {
    lines.push(`${pad}- other properties: any`);
  } else if (typeof shape.additionalProperties === 'object') {
    nested('other properties', shape.additionalProperties);
  }
  const variants = [
    ['any of', shape.anyOf],
    ['one of', shape.oneOf],
    ['all of', shape.allOf],
  ] as const;
  for (const [label, list] of variants) {
    if (list === undefined) continue;
    lines.push(`${pad}- ${label}:`);
    for (const variant of list) {
      lines.push(`${pad}  - ${shapeHead(variant)}`);
      lines.push(...shapeLines(variant, depth + 2));
    }
  }
  return lines;
}

const contentLines = (
  content: readonly OperationContent[],
  depth: number,
): string[] =>
  content.flatMap(({ mediaType, schema }) =>
    schema === undefined
      ? [`${indent(depth)}- ${mediaType}`]
      : [
          `${indent(depth)}- ${mediaType}: ${shapeHead(schema)}`,
          ...shapeLines(schema, depth + 1),
        ],
  );

/**
 * Writes the definition of an operation, without method, path, summary
 * and rights, which a result gives in fields of their own.
 *
 * @param fact - The operation from the facts.
 * @returns The text, one line for each field. The same facts always give
 *   the same text, so its parts stay the same between calls.
 * @example
 * ```ts
 * renderDefinition(fact);
 * // 'Tags: Group\nDescription: …\nParameters:\n- groupId (path, required): integer …'
 * ```
 */
export function renderDefinition(fact: OperationFact): string {
  const lines: string[] = [];
  if (fact.tags.length > 0) lines.push(`Tags: ${fact.tags.join(', ')}`);
  // The description of the operation keeps its lines: it can hold lists
  // and paragraphs that say how to call it.
  if (fact.description !== undefined) {
    lines.push(`Description: ${fact.description}`);
  }
  if (fact.parameters.length === 0) {
    lines.push('Parameters: none');
  } else {
    lines.push('Parameters:');
    for (const parameter of fact.parameters) {
      const where = parameter.required
        ? `${parameter.in}, required`
        : parameter.in;
      const head =
        parameter.schema === undefined ? 'any' : shapeHead(parameter.schema);
      const about =
        parameter.description === undefined
          ? ''
          : `. ${oneLine(parameter.description)}`;
      lines.push(`- ${parameter.name} (${where}): ${head}${about}`);
      if (parameter.schema !== undefined) {
        lines.push(...shapeLines(parameter.schema, 1));
      }
    }
  }
  const body = fact.requestBody;
  if (body === undefined) {
    lines.push('Request body: none');
  } else {
    const about =
      body.description === undefined ? '' : ` ${oneLine(body.description)}`;
    lines.push(
      `Request body${body.required ? ' (required)' : ''}:${about}`,
      ...contentLines(body.content, 1),
    );
  }
  lines.push(fact.responses.length === 0 ? 'Responses: none' : 'Responses:');
  for (const response of fact.responses) {
    const about =
      response.description === undefined
        ? ''
        : ` ${oneLine(response.description)}`;
    lines.push(
      `- ${response.status}:${about}`,
      ...contentLines(response.content, 1),
    );
  }
  return lines.join('\n');
}
