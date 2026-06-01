// Boot-time loader for the per-deployment tenants.json (#253).
//
// Thin wrapper around `parseTenantsConfig`: reads the file from disk, parses
// it as JSON, and delegates structural validation to the shared parser. We
// keep the file I/O out of `shared/routes.ts` so the parser stays purely
// functional and easily testable from in-memory blobs.
//
// Fatal on any error — malformed config or missing file refuses the boot.
// Same boot-refuse pattern as the legacy `loadHomesConfig`.

import { readFileSync } from 'node:fs';
import { parseTenantsConfig } from '../shared/routes';
import type { TenantsConfig } from '../shared/types';

export function loadTenantsConfig(path: string): TenantsConfig {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`tenants config not readable at ${path}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`tenants config at ${path} is not valid JSON: ${(err as Error).message}`);
  }
  return parseTenantsConfig(parsed);
}
