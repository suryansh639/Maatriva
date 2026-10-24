import { describe, expect, it } from 'vitest';
import { isSessionExpired, loginMode, parseSession, sessionFromLogin } from './auth';
import type { LoginResponse } from './types';

const login: LoginResponse = {
  access_token: 'tok',
  token_type: 'bearer',
  expires_at: '2025-01-08T00:00:00Z',
  user: {
    id: 'u1',
    username: 'asha1',
    full_name: 'Asha One',
    role: 'asha',
    facility_id: 'f1',
    facility_name: 'Demo PHC',
    village_ids: ['v1', 'v2'],
  },
};

describe('session storage format', () => {
  it('round-trips a login response through JSON', () => {
    const session = sessionFromLogin(login);
    expect(parseSession(JSON.stringify(session))).toEqual(session);
  });

  it('rejects missing, corrupt and malformed values', () => {
    expect(parseSession(null)).toBeNull();
    expect(parseSession('{not json')).toBeNull();
    expect(parseSession(JSON.stringify({ token: '', expiresAt: 'x', user: login.user }))).toBeNull();
    expect(
      parseSession(
        JSON.stringify({ token: 't', expiresAt: 'x', user: { ...login.user, role: 'root' } }),
      ),
    ).toBeNull();
  });
});

describe('isSessionExpired', () => {
  const session = sessionFromLogin(login);
  const exp = Date.parse(login.expires_at);

  it('is false before and true at or after the expiry', () => {
    expect(isSessionExpired(session, exp - 1)).toBe(false);
    expect(isSessionExpired(session, exp)).toBe(true);
  });

  it('treats an unparseable expiry as expired', () => {
    expect(isSessionExpired({ ...session, expiresAt: 'soon' }, 0)).toBe(true);
  });
});

describe('loginMode', () => {
  const session = sessionFromLogin(login);

  it('shows the form without a usable session', () => {
    expect(loginMode(null, false, false)).toBe('form');
    // An expired staff session is not usable.
    expect(loginMode({ ...session, user: { ...session.user, role: 'doctor' } }, false, true)).toBe('form');
  });

  it('redirects a usable session whose token still works', () => {
    expect(loginMode(session, true, false)).toBe('redirect');
  });

  it('lets an ASHA with an expired token sign in again (Req 37.5)', () => {
    expect(loginMode(session, true, true)).toBe('reauth');
  });
});
