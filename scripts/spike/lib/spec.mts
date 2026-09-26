/**
 * Reads the OpenAPI document that the instance publishes about itself.
 *
 * The probes call an endpoint only after they found it in this document,
 * and they print a key of a response only if the document declares it.
 * Operations are looked up by method and path template, so the probes do
 * not depend on operation IDs. Both OpenAPI 3 and Swagger 2 documents are
 * read.
 *
 * @packageDocumentation
 */

/** A JSON object with unknown content. */
export type JsonObject = Readonly<Record<string, unknown>>;

/** An OpenAPI or Swagger document. */
export interface OpenApiDocument extends JsonObject {
  readonly paths: JsonObject;
}

/** HTTP methods an operation can use. */
export type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

/**
 * Tells whether a value is a JSON object.
 *
 * @param value - Any value.
 * @returns Whether the value is a plain object and not an array.
 */
export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Accepts a parsed value as an OpenAPI or Swagger document.
 *
 * @param value - Parsed JSON.
 * @returns The document, or `undefined` if it is none.
 */
export function asOpenApi(value: unknown): OpenApiDocument | undefined {
  if (!isObject(value) || !isObject(value['paths'])) {
    return undefined;
  }
  const openapi = value['openapi'];
  const swagger = value['swagger'];
  if (typeof openapi !== 'string' && typeof swagger !== 'string') {
    return undefined;
  }
  return value as OpenApiDocument;
}

/**
 * Finds the path prefix that the document puts in front of every path.
 *
 * OpenAPI 3 names it in the first server URL, Swagger 2 in `basePath`.
 * Only the path of a server URL counts, never its host.
 *
 * @param document - The OpenAPI document.
 * @returns The prefix without a trailing slash, possibly empty.
 */
export function basePath(document: OpenApiDocument): string {
  const servers = document['servers'];
  let prefix = '';
  if (Array.isArray(servers) && isObject(servers[0])) {
    const url = servers[0]['url'];
    if (typeof url === 'string') {
      prefix = /^[a-z][a-z0-9+.-]*:/i.test(url)
        ? (URL.parse(url)?.pathname ?? '')
        : url;
    }
  } else if (typeof document['basePath'] === 'string') {
    prefix = document['basePath'];
  }
  return prefix.replace(/\/+$/, '');
}

/**
 * Normalises a path template, so that parameter names do not matter.
 *
 * @param path - Path with parameters in braces, such as `/pages/{id}`.
 * @returns The path with every parameter written as `{}`, without a trailing slash.
 */
export function normalizeTemplate(path: string): string {
  const normalized = path.replace(/\{[^}]*\}/g, '{}').replace(/\/+$/, '');
  return normalized === '' ? '/' : normalized;
}

/**
 * Finds an operation by method and path template.
 *
 * @param document - The OpenAPI document of the instance.
 * @param method - HTTP method in lower case.
 * @param template - Full path including the prefix, such as `/api/whoami`.
 * @returns The operation object, or `undefined` if the instance does not document it.
 */
export function findOperation(
  document: OpenApiDocument,
  method: Method,
  template: string,
): JsonObject | undefined {
  const wanted = normalizeTemplate(template);
  const prefix = basePath(document);
  for (const [path, item] of Object.entries(document.paths)) {
    if (normalizeTemplate(`${prefix}${path}`) === wanted && isObject(item)) {
      const operation = item[method];
      if (isObject(operation)) {
        return operation;
      }
    }
  }
  return undefined;
}

/**
 * Resolves references and reads schemas of an OpenAPI document.
 *
 * @example
 * ```ts
 * const schemas = new Schemas(document);
 * const person = schemas.resolve({ $ref: '#/components/schemas/Person' });
 * schemas.properties(person).has('firstName');
 * ```
 */
export class Schemas {
  readonly #document: OpenApiDocument;

  /**
   * Prepares reading the schemas of a document.
   *
   * @param document - The OpenAPI document of the instance.
   */
  constructor(document: OpenApiDocument) {
    this.#document = document;
  }

  /**
   * Follows `$ref` references within the document.
   *
   * Only references into the same document are followed, at most 32 in a
   * row, so a cycle ends instead of running forever.
   *
   * @param node - A schema or a reference to one.
   * @returns The schema object, or `undefined` if it cannot be resolved.
   */
  resolve(node: unknown): JsonObject | undefined {
    let current = node;
    for (let hops = 0; hops < 32; hops++) {
      if (!isObject(current)) {
        return undefined;
      }
      const reference = current['$ref'];
      if (typeof reference !== 'string') {
        return current;
      }
      current = this.#pointer(reference);
    }
    return undefined;
  }

  /**
   * Lists the properties an object schema declares, including those of
   * `allOf`, `oneOf` and `anyOf` parts.
   *
   * @param node - A schema or a reference to one.
   * @returns Each declared property with its schema.
   */
  properties(node: unknown): ReadonlyMap<string, unknown> {
    const found = new Map<string, unknown>();
    const seen = new Set<JsonObject>();
    const collect = (part: unknown): void => {
      const schema = this.resolve(part);
      if (schema === undefined || seen.has(schema)) {
        return;
      }
      seen.add(schema);
      const properties = schema['properties'];
      if (isObject(properties)) {
        for (const [name, child] of Object.entries(properties)) {
          if (!found.has(name)) {
            found.set(name, child);
          }
        }
      }
      for (const combiner of ['allOf', 'oneOf', 'anyOf']) {
        const parts = schema[combiner];
        if (Array.isArray(parts)) {
          for (const item of parts) {
            collect(item);
          }
        }
      }
    };
    collect(node);
    return found;
  }

  /**
   * Finds the schema of the entries of an array schema.
   *
   * @param node - A schema or a reference to one.
   * @returns The schema of the entries, or `undefined` if none is declared.
   */
  items(node: unknown): unknown {
    return this.resolve(node)?.['items'];
  }

  /**
   * Finds the schema of the values of a map-like object schema.
   *
   * @param node - A schema or a reference to one.
   * @returns The schema of `additionalProperties`, or `undefined`.
   */
  additionalProperties(node: unknown): unknown {
    const value = this.resolve(node)?.['additionalProperties'];
    return isObject(value) ? value : undefined;
  }

  /**
   * Finds the schema of a response of an operation.
   *
   * Looks for the exact status first, then for its class such as `4XX`,
   * then for `default`. Reads JSON content in OpenAPI 3 and the `schema`
   * field in Swagger 2.
   *
   * @param operation - The operation object.
   * @param status - HTTP status of the response.
   * @returns The schema of the response body, or `undefined`.
   */
  responseSchema(operation: JsonObject, status: number): unknown {
    const responses = operation['responses'];
    if (!isObject(responses)) {
      return undefined;
    }
    const code = String(status);
    const response = this.resolve(
      responses[code] ??
        responses[`${code.charAt(0)}XX`] ??
        responses['default'],
    );
    if (response === undefined) {
      return undefined;
    }
    const content = response['content'];
    if (isObject(content)) {
      const json = Object.entries(content).find(([type]) =>
        type.includes('json'),
      );
      return isObject(json?.[1]) ? json[1]['schema'] : undefined;
    }
    return response['schema'];
  }

  /**
   * Lists the names of the query parameters an operation declares.
   *
   * @param operation - The operation object.
   * @returns The declared names, such as `page` or `ids[]`.
   */
  queryParameters(operation: JsonObject): ReadonlySet<string> {
    const names = new Set<string>();
    const parameters = operation['parameters'];
    if (Array.isArray(parameters)) {
      for (const item of parameters) {
        const parameter = this.resolve(item);
        const name = parameter?.['name'];
        if (parameter?.['in'] === 'query' && typeof name === 'string') {
          names.add(name);
        }
      }
    }
    return names;
  }

  #pointer(reference: string): unknown {
    if (!reference.startsWith('#/')) {
      return undefined;
    }
    let current: unknown = this.#document;
    for (const raw of reference.slice(2).split('/')) {
      let decoded: string;
      try {
        decoded = decodeURIComponent(raw);
      } catch {
        return undefined;
      }
      const key = decoded.replaceAll('~1', '/').replaceAll('~0', '~');
      if (!isObject(current)) {
        return undefined;
      }
      current = current[key];
    }
    return current;
  }
}
