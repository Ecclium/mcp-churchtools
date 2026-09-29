// Architecture rules for every import in packages/, checked by
// `pnpm check:arch` (ADR 0022). The rules come from
// tests/architecture/boundaries.json; tests/architecture/dependency-rules.mts
// turns them into this configuration and explains each rule and setting.
// The architecture tests load this same file.
import {
  loadBoundaries,
  workspaceRoot,
} from './tests/architecture/boundaries.mts';
import { dependencyCruiserConfig } from './tests/architecture/dependency-rules.mts';

export default dependencyCruiserConfig(loadBoundaries(), workspaceRoot);
