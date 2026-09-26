/**
 * The operations of the ChurchTools API that the spike looks at.
 *
 * The paths follow the public OpenAPI document of ChurchTools. Before a
 * probe calls one, it looks it up by method and path in the document of
 * the instance itself. If the instance does not document it, the probe
 * reports that and calls nothing. The write operations are only looked
 * up, never called.
 *
 * @packageDocumentation
 */
import type { Method } from './spec.mts';

/** One operation: method and path template with `{}` for parameters. */
export interface OperationTemplate {
  readonly method: Method;
  readonly template: string;
}

/** Where every ChurchTools instance publishes its OpenAPI document. */
export const specificationPath = '/system/runtime/swagger/openapi.json';

/** The operations the spike needs, by the name the output uses. */
export const operations = {
  info: { method: 'get', template: '/api/info' },
  whoami: { method: 'get', template: '/api/whoami' },
  permissionsGlobal: { method: 'get', template: '/api/permissions/global' },
  wikiPages: { method: 'get', template: '/api/wiki/pages' },
  wikiCategoryPages: {
    method: 'get',
    template: '/api/wiki/categories/{}/pages',
  },
  wikiPage: { method: 'get', template: '/api/wiki/categories/{}/pages/{}' },
  wikiPageVersions: {
    method: 'get',
    template: '/api/wiki/categories/{}/pages/{}/versions',
  },
  wikiPageVersion: {
    method: 'get',
    template: '/api/wiki/categories/{}/pages/{}/versions/{}',
  },
  wikiPageCreate: {
    method: 'post',
    template: '/api/wiki/categories/{}/pages',
  },
  wikiPageUpdate: {
    method: 'patch',
    template: '/api/wiki/categories/{}/pages/{}',
  },
} as const satisfies Readonly<Record<string, OperationTemplate>>;

/** The name of one operation. */
export type OperationName = keyof typeof operations;
