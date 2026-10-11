/**
 * The operations of the ChurchTools API that the spike looks at.
 *
 * The paths follow the public OpenAPI document of ChurchTools. Before a
 * probe calls one, it looks it up by method and path in the document of
 * the instance itself. If the instance does not document it, a reading
 * probe reports that and calls nothing, and a probe of the write account
 * stops. Only the write probes call the write operations, through the
 * client the guard of the test environment hands out (ADR 0049).
 *
 * The operations on persons, groups and search are marked `personal`:
 * their answers carry personal data.
 *
 * @packageDocumentation
 */
import type { Method } from './spec.mts';

/** One operation: method and path template with `{}` for parameters. */
export interface OperationTemplate {
  readonly method: Method;
  readonly template: string;
  /** Set for operations whose answers carry personal data. */
  readonly personal?: true;
}

/** Where every ChurchTools instance publishes its OpenAPI document. */
export const specificationPath = '/system/runtime/swagger/openapi.json';

/** The operations the spike needs, by the name the output uses. */
export const operations = {
  info: { method: 'get', template: '/api/info' },
  whoami: { method: 'get', template: '/api/whoami' },
  permissionsGlobal: { method: 'get', template: '/api/permissions/global' },
  wikiPages: { method: 'get', template: '/api/wiki/pages' },
  wikiCategories: { method: 'get', template: '/api/wiki/categories' },
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
  wikiPageDelete: {
    method: 'delete',
    template: '/api/wiki/categories/{}/pages/{}',
  },
  persons: { method: 'get', template: '/api/persons', personal: true },
  person: { method: 'get', template: '/api/persons/{}', personal: true },
  personGroups: {
    method: 'get',
    template: '/api/persons/{}/groups',
    personal: true,
  },
  groups: { method: 'get', template: '/api/groups', personal: true },
  group: { method: 'get', template: '/api/groups/{}', personal: true },
  groupMembers: {
    method: 'get',
    template: '/api/groups/{}/members',
    personal: true,
  },
  search: { method: 'get', template: '/api/search', personal: true },
} as const satisfies Readonly<Record<string, OperationTemplate>>;

/** The name of one operation. */
export type OperationName = keyof typeof operations;
