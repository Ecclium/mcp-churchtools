/**
 * Synthetic facts of the docs index for tests (ADR 0066). They follow the
 * formats of `docs-index` but describe nothing that exists: a module
 * `synthetic` with things and their members, two help pages under
 * `/de/help/synthetisch/` and a person called «Person A». No operation,
 * right or page here is taken from ChurchTools.
 *
 * @packageDocumentation
 */
import {
  canonicalJson,
  type FactFileTexts,
  type Facts,
} from '@ecclium/mcp-churchtools-docs-index';

/** The path of the synthetic help page on rights. */
export const syntheticRightsPage = '/de/help/synthetisch/dinge-rechte/';

/** The path of the synthetic help page on things. */
export const syntheticThingsPage = '/de/help/synthetisch/dinge-verwalten/';

/**
 * Builds a fresh set of synthetic facts, sorted and valid, with one
 * source for each file.
 *
 * @returns The facts; each call returns new objects.
 * @example
 * ```ts
 * const facts = syntheticFacts();
 * facts.operations.entries[0]?.operationId; // 'deleteSyntheticThing'
 * ```
 */
export function syntheticFacts(): Facts {
  // A new object for each operation, so that a test can change one.
  const thingId = () =>
    ({
      name: 'thingId',
      in: 'path',
      required: true,
      schema: { type: ['integer'] },
    }) as const;
  return {
    sources: {
      format: 'ecclium.docs.sources.v1',
      openapi: {
        retrievedAt: '2026-10-29T08:00:00Z',
        sha256: '1'.repeat(64),
        documentVersion: '0.1.0',
        churchToolsVersion: '3.138',
      },
      permissions: {
        retrievedAt: '2026-10-29T08:01:00Z',
        sha256: '2'.repeat(64),
        churchToolsVersion: '3.138',
      },
      academy: {
        retrievedAt: '2026-10-29T08:02:00Z',
        pages: [
          { path: syntheticRightsPage, sha256: '3'.repeat(64) },
          { path: syntheticThingsPage, sha256: '4'.repeat(64) },
        ],
      },
    },
    operations: {
      format: 'ecclium.docs.operations.v1',
      notice: 'Synthetische Fakten für Tests, aus keiner Quelle.',
      entries: [
        {
          operationId: 'deleteSyntheticThing',
          method: 'delete',
          path: '/api/synthetic/things/{thingId}',
          tags: ['Synthetic'],
          summary: 'Delete a synthetic thing',
          deprecated: true,
          parameters: [thingId()],
          responses: [{ status: '204', content: [] }],
        },
        {
          operationId: 'getSyntheticThing',
          method: 'get',
          path: '/api/synthetic/things/{thingId}',
          tags: ['Synthetic'],
          summary: 'Get one synthetic thing',
          description:
            'Returns a synthetic thing.\n\nRequires the right view things of the module synthetic.',
          deprecated: false,
          parameters: [thingId()],
          responses: [
            {
              status: '200',
              description: 'The thing.',
              content: [
                {
                  mediaType: 'application/json',
                  schema: {
                    type: ['object'],
                    properties: [
                      {
                        name: 'data',
                        required: true,
                        schema: {
                          type: ['object'],
                          properties: [
                            {
                              name: 'id',
                              required: true,
                              schema: { type: ['integer'] },
                            },
                            {
                              name: 'name',
                              required: true,
                              schema: { type: ['string'] },
                            },
                          ],
                        },
                      },
                    ],
                  },
                },
              ],
            },
            { status: '404', content: [] },
          ],
        },
        {
          operationId: 'getSyntheticThingMembers',
          method: 'get',
          path: '/api/synthetic/things/{thingId}/members',
          tags: ['Synthetic'],
          summary: 'List the members of a synthetic thing',
          description: 'Requires the right view thing members.',
          deprecated: false,
          parameters: [
            thingId(),
            {
              name: 'limit',
              in: 'query',
              required: false,
              schema: { type: ['integer'] },
            },
            {
              name: 'page',
              in: 'query',
              required: false,
              schema: { type: ['integer'] },
            },
          ],
          responses: [
            {
              status: '200',
              content: [
                {
                  mediaType: 'application/json',
                  schema: {
                    type: ['array'],
                    items: { ref: 'SyntheticMember' },
                  },
                },
              ],
            },
          ],
        },
        {
          operationId: 'listSyntheticThings',
          method: 'get',
          path: '/api/synthetic/things',
          tags: ['Synthetic'],
          summary: 'Search synthetic things by name',
          deprecated: false,
          parameters: [
            {
              name: 'query',
              in: 'query',
              required: false,
              description: 'A part of the name.',
              schema: { type: ['string'] },
            },
          ],
          responses: [{ status: '200', content: [] }],
        },
        {
          operationId: 'postSyntheticThing',
          method: 'post',
          path: '/api/synthetic/things',
          tags: ['Synthetic'],
          summary: 'Create a synthetic thing',
          deprecated: false,
          parameters: [],
          requestBody: {
            required: true,
            content: [
              {
                mediaType: 'application/json',
                schema: {
                  type: ['object'],
                  properties: [
                    {
                      name: 'name',
                      required: true,
                      schema: { type: ['string'] },
                    },
                  ],
                },
              },
            ],
          },
          responses: [{ status: '201', content: [] }],
        },
      ],
    },
    rights: {
      format: 'ecclium.docs.rights.v1',
      notice: 'Synthetische Fakten für Tests, aus keiner Quelle.',
      entries: [
        {
          module: 'synthetic',
          name: 'edit things',
          kind: 'list',
          label: { text: 'Dinge bearbeiten', page: syntheticRightsPage },
          pages: [syntheticRightsPage],
        },
        {
          module: 'synthetic',
          name: 'view',
          kind: 'boolean',
          label: { text: 'Modul «Dinge» sehen', page: syntheticRightsPage },
          pages: [syntheticRightsPage],
        },
        {
          module: 'synthetic',
          name: 'view thing members',
          kind: 'list',
          label: {
            text: 'Mitglieder der Dinge sehen',
            page: syntheticRightsPage,
          },
          pages: [syntheticRightsPage, syntheticThingsPage],
        },
        {
          module: 'synthetic',
          name: 'view things',
          kind: 'list',
          label: { text: 'Dinge sehen', page: syntheticRightsPage },
          pages: [syntheticRightsPage],
        },
      ],
    },
    academy: {
      format: 'ecclium.docs.academy.v1',
      notice: 'Synthetische Fakten für Tests, aus keiner Quelle.',
      entries: [
        {
          path: syntheticRightsPage,
          title: 'Rechte für Dinge',
          section: 'synthetisch',
          knowledgeBase: 'rechteverwaltung',
          modified: '2026-10-01',
          text: [
            '# Rechte für Dinge',
            '',
            'Wer die Mitglieder eines Dings sehen will, braucht das Recht **Mitglieder der Dinge sehen**.',
            '',
            '- Dinge sehen',
            '- Dinge bearbeiten',
            '',
            `Siehe auch [Dinge verwalten](${syntheticThingsPage}).`,
          ].join('\n'),
        },
        {
          path: syntheticThingsPage,
          title: 'Dinge verwalten',
          section: 'synthetisch',
          knowledgeBase: 'churchtools-module',
          modified: '2025-06-30',
          text: [
            '# Dinge verwalten',
            '',
            'Person A legt ein Ding an und fügt Gruppenmitglieder hinzu. Sie stehen danach in der Mitgliederliste des Dings.',
            '',
            '| Feld | Bedeutung |',
            '| --- | --- |',
            '| Name | Der Name des Dings |',
          ].join('\n'),
        },
      ],
    },
  };
}

/**
 * Writes facts as the texts of the files under `data/`, in canonical form.
 *
 * @param facts - The facts, by default {@link syntheticFacts}.
 * @returns The text of each file.
 * @example
 * ```ts
 * const texts = syntheticFactFiles();
 * parseFactFiles(texts); // passes
 * ```
 */
export function syntheticFactFiles(
  facts: Facts = syntheticFacts(),
): FactFileTexts {
  return {
    'SOURCES.json': canonicalJson(facts.sources),
    'operations.json': canonicalJson(facts.operations),
    'rights.json': canonicalJson(facts.rights),
    'academy.json': canonicalJson(facts.academy),
  };
}
