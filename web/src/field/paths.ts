/**
 * Field-area route paths. `FieldLayout` links to these; task 18.8 mounts the
 * matching routes under `/field/*`.
 */
export const FIELD_PATHS = {
  mothers: '/field',
  register: '/field/register',
  tasks: '/field/tasks',
  syncErrors: '/field/sync-errors',
} as const;

/** Mother detail screen. */
export function motherPath(motherId: string): string {
  return `/field/mother/${encodeURIComponent(motherId)}`;
}

/** New-visit screen for a mother. */
export function newVisitPath(motherId: string): string {
  return `/field/mother/${encodeURIComponent(motherId)}/visit`;
}
