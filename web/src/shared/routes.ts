/**
 * Role → area mapping (Req 37.2, 37.4). Pure, so it can be unit-tested without a router.
 *
 * - ASHA → `/field`
 * - Doctor and ANM → `/doctor` (the ANM view is read-only, Req 37.8)
 * - Admin → `/admin` (placeholder, Req 37.3)
 */
import type { Role } from './types';

export type Area = 'field' | 'doctor' | 'admin';

export const LOGIN_PATH = '/login';

export const AREA_PATHS: Readonly<Record<Area, string>> = {
  field: '/field',
  doctor: '/doctor',
  admin: '/admin',
};

export const AREA_ROLES: Readonly<Record<Area, readonly Role[]>> = {
  field: ['asha'],
  doctor: ['doctor', 'anm'],
  admin: ['admin'],
};

const ROLE_AREA: Readonly<Record<Role, Area>> = {
  asha: 'field',
  doctor: 'doctor',
  anm: 'doctor',
  admin: 'admin',
};

/** The area a role belongs to. */
export function areaForRole(role: Role): Area {
  return ROLE_AREA[role];
}

/** The home route a signed-in user is redirected to from `/` or a wrong area. */
export function homeRouteForRole(role: Role): string {
  return AREA_PATHS[areaForRole(role)];
}

export function canAccessArea(role: Role, area: Area): boolean {
  return AREA_ROLES[area].includes(role);
}

/** The area a pathname belongs to, or null for `/`, `/login` and unknown paths. */
export function areaForPath(pathname: string): Area | null {
  for (const area of Object.keys(AREA_PATHS) as Area[]) {
    const base = AREA_PATHS[area];
    if (pathname === base || pathname.startsWith(`${base}/`)) return area;
  }
  return null;
}

/**
 * Where to go after sign-in: the originally requested path when the role may open
 * it, otherwise the role's home route.
 */
export function postLoginRoute(role: Role, requestedPath: string | null | undefined): string {
  if (requestedPath) {
    const area = areaForPath(requestedPath);
    if (area && canAccessArea(role, area)) return requestedPath;
  }
  return homeRouteForRole(role);
}
