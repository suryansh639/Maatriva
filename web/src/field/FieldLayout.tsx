/**
 * Mobile-first field layout (Req 28, 29.1, 29.2, 32.3, 37.5, 37.7).
 *
 * Must render inside `I18nProvider`, `AuthProvider`, `SyncProvider` and a router
 * (task 18.8 mounts it for `/field/*`). It shows:
 *
 * - a header with the app name, the `SyncBadge`, "Sync now", the English/Hindi
 *   toggle, the "Simulate offline" switch and "Log out";
 * - the current screen (`children`, or the nested route `<Outlet />`);
 * - bottom navigation for Mothers, Register and Tasks, with the open-task count.
 *
 * The badge opens the sync-errors screen. In the "Sign in to sync" state (expired
 * token or a 401) it opens the login page instead, keeping the cached session so
 * local work continues until a new login replaces it (Req 37.5).
 * Logging out with queued changes asks for confirmation first, and never deletes
 * the user's Dexie database, so the queue syncs after the next sign-in.
 *
 * Every control is at least 48×48 px with an 18 px base font (`.field-area`), and
 * every icon is decorative next to a text label.
 */
import { useCallback } from 'react';
import type { ReactNode } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';

import { useAuth } from '../shared/auth';
import { useI18n } from '../shared/I18nProvider';
import { LOGIN_PATH } from '../shared/routes';
import { LanguageToggle } from './components/LanguageToggle';
import { OfflineToggle } from './components/OfflineToggle';
import { confirmLogout } from './logout';
import { FIELD_PATHS } from './paths';
import type { BadgeState } from './sync/badge';
import { SyncBadge } from './sync/SyncBadge';
import { useSync } from './sync/SyncProvider';
import './field.css';

/**
 * Logout for the field area: confirms when the outbox is not empty (Req 37.7),
 * clears the session (the Dexie database stays) and goes to the login page,
 * remembering the current path so sign-in returns there.
 */
export function useFieldLogout(): () => void {
  const { logout } = useAuth();
  const { pendingCount } = useSync();
  const { t } = useI18n();
  const navigate = useNavigate();
  const location = useLocation();

  return useCallback(() => {
    if (!confirmLogout(pendingCount, t)) return;
    const from = location.pathname;
    logout();
    navigate(LOGIN_PATH, { replace: true, state: { from } });
  }, [pendingCount, t, logout, navigate, location.pathname]);
}

function navClass({ isActive }: { isActive: boolean }): string {
  return isActive ? 'field-nav__link field-nav__link--active' : 'field-nav__link';
}

export interface FieldLayoutProps {
  /** Screen content; defaults to the nested route's `<Outlet />`. */
  children?: ReactNode;
}

export function FieldLayout({ children }: FieldLayoutProps) {
  const { t, lang } = useI18n();
  const { db, status, simulatedOffline, syncNow } = useSync();
  const navigate = useNavigate();
  const location = useLocation();
  const logout = useFieldLogout();

  const openTasks = useLiveQuery(() => db.tasks.where('status').equals('open').count(), [db], 0);

  const onBadge = useCallback(
    (badge: BadgeState) => {
      if (badge.kind === 'signIn') {
        // Keep the session (and local work) until the new login replaces it.
        navigate(LOGIN_PATH, { state: { from: location.pathname } });
        return;
      }
      navigate(FIELD_PATHS.syncErrors);
    },
    [navigate, location.pathname],
  );

  const offline = simulatedOffline || !status.online;

  return (
    <div className="field-area field-layout" lang={lang}>
      <header className="field-header">
        <div className="field-header__row">
          <span className="field-header__brand">{t('field.app.name')}</span>
          <SyncBadge onActivate={onBadge} />
        </div>
        <div className="field-header__row field-header__controls">
          <button
            type="button"
            className="field-btn"
            data-testid="sync-now"
            onClick={() => void syncNow()}
            disabled={status.syncing || offline}
          >
            <span aria-hidden="true">⟳</span> {t('sync.now')}
          </button>
          <OfflineToggle />
          <LanguageToggle />
          <button type="button" className="field-btn" data-testid="logout" onClick={logout}>
            <span aria-hidden="true">⎋</span> {t('field.common.logout')}
          </button>
        </div>
      </header>

      <main id="field-main" className="field-main">
        {children ?? <Outlet />}
      </main>

      <nav className="field-nav" aria-label={t('field.nav.label')}>
        <NavLink to={FIELD_PATHS.mothers} end className={navClass}>
          <span className="field-nav__icon" aria-hidden="true">
            ♀
          </span>
          <span>{t('field.nav.mothers')}</span>
        </NavLink>
        <NavLink to={FIELD_PATHS.register} className={navClass}>
          <span className="field-nav__icon" aria-hidden="true">
            ＋
          </span>
          <span>{t('field.nav.register')}</span>
        </NavLink>
        <NavLink to={FIELD_PATHS.tasks} className={navClass} data-testid="nav-tasks">
          <span className="field-nav__icon" aria-hidden="true">
            ☑
          </span>
          <span>{t('field.nav.tasks')}</span>
          {openTasks > 0 ? (
            <>
              <span className="field-nav__count" aria-hidden="true">
                {openTasks}
              </span>
              {' '}
              <span className="visually-hidden">({t('field.nav.openTasks', { n: openTasks })})</span>
            </>
          ) : null}
        </NavLink>
      </nav>
    </div>
  );
}

export default FieldLayout;
