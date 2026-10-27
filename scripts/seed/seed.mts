/**
 * The seed of the test instance (ADR 0061).
 *
 * Creates the synthetic data of the test instance behind the guard of the
 * seed account, and resets it again. Usage: see README.md in this folder.
 *
 * ```sh
 * node scripts/seed/seed.mts pruefen
 * node scripts/seed/seed.mts anlegen
 * node scripts/seed/seed.mts zuruecksetzen
 * ```
 *
 * @packageDocumentation
 */
import { main } from './lib/course.mts';

if (import.meta.main) {
  process.exitCode = await main(import.meta.url);
}
