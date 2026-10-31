/**
 * The keys of the core (ADR 0069): the secret behind the pseudonyms of the
 * level `strict` and the provider that derives the keys of a day from it.
 * The function that reads the bytes of a secret stays inside, held by the
 * rule `keys-internals`.
 *
 * @packageDocumentation
 */
export { createFileKeyProvider, type FileKeys } from './file-provider.js';
export { KeyMaterial, keyMaterialLength } from './key-material.js';
