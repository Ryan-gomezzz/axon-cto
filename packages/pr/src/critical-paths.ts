import { minimatch } from 'minimatch';

/**
 * Globs that mark a PR as "critical" — touching these triggers an instant
 * Telegram alert via the realtime path. Keep this list small and curated;
 * a noisy critical-path list trains the team to ignore alerts.
 */
export const CRITICAL_PATHS: string[] = [
  'packages/auth/**',
  'packages/payments/**',
  'packages/notifications/**',
  'packages/shared/src/jwt.ts',
  'packages/shared/src/auth/**',
  'infra/**',
  '.github/workflows/**',
  'docker-compose*.yml',
  'k8s/**',
];

export function matchesCriticalPath(filesChanged: string[]): boolean {
  for (const file of filesChanged) {
    for (const pattern of CRITICAL_PATHS) {
      if (minimatch(file, pattern)) return true;
    }
  }
  return false;
}

/**
 * Best-effort mapping from a critical-path glob to a KG service name. Used by
 * the realtime alert to say "touching auth-service". Returns the union of
 * services any of the changed files belong to, deduplicated and stable-sorted.
 */
const PATH_TO_SERVICE: Array<[pattern: string, service: string]> = [
  ['packages/auth/**', 'auth-service'],
  ['packages/payments/**', 'payments-service'],
  ['packages/notifications/**', 'notifications-service'],
  ['infra/**', 'infra'],
  ['k8s/**', 'infra'],
  ['.github/workflows/**', 'ci'],
  ['docker-compose*.yml', 'infra'],
];

export function inferServices(filesChanged: string[]): string[] {
  const matched = new Set<string>();
  for (const file of filesChanged) {
    for (const [pattern, service] of PATH_TO_SERVICE) {
      if (minimatch(file, pattern)) matched.add(service);
    }
  }
  return Array.from(matched).sort();
}
