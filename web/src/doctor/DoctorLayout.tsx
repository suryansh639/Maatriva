/**
 * Doctor / ANM area shell (design §15.5, §17). English only (Req 32.6).
 *
 * Header: brand, facility, synthetic-data note, navigation, the live status, the
 * signed-in user and role (ANM is read-only, Req 37.8) and logout. A skip link
 * jumps to the main content, so keyboard users reach the dashboard filters first
 * (Req 38.4).
 *
 * Live updates: the layout calls `useLiveEvents()` once (doctor: SSE; ANM: 30 s
 * refetch tick) and passes it to every page, so all pages share one stream. It
 * also owns the RED alert toast ("Open patient"), so a doctor sees it on any
 * doctor page, exactly once per event.
 *
 * Routes (lazy-loaded as a whole from `App.tsx`, Req 36.6):
 * - index        → DashboardPage
 * - `mother/:id` → PatientDetail
 * - `digest`     → DigestPage (doctor and ANM, Req 25.3)
 * - anything else redirects to the dashboard
 */
import { Navigate, NavLink, Route, Routes, useNavigate } from 'react-router-dom';
import { useAuth } from '../shared/auth';
import { AREA_PATHS, LOGIN_PATH } from '../shared/routes';
import DashboardPage from './DashboardPage';
import { liveStatusText } from './dashboardLive';
import DigestPage from './DigestPage';
import { useLiveEvents } from './live/useLiveEvents';
import { PatientDetail } from './PatientDetail';
import { useRedAlertToasts } from './useRedAlertToasts';
import './dashboard.css';

export const SYNTHETIC_NOTE = 'Synthetic data only – no real personal data';

export default function DoctorLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const readOnly = user?.role === 'anm';

  const live = useLiveEvents();
  useRedAlertToasts(live.subscribe);
  const statusText = liveStatusText(live);

  return (
    <div className="staff-area doctor-area">
      <a className="skip-link" href="#doctor-main">
        Skip to main content
      </a>
      <header className="doctor-header">
        <div className="doctor-header__brand">
          <p className="doctor-header__app">Maatriva PHC dashboard</p>
          <h1 className="doctor-header__facility">{user?.facility_name ?? 'PHC'}</h1>
          <p className="doctor-header__note">{SYNTHETIC_NOTE}</p>
        </div>
        <nav className="doctor-header__nav" aria-label="Dashboard sections">
          <NavLink to={AREA_PATHS.doctor} end>
            Dashboard
          </NavLink>
          <NavLink to={`${AREA_PATHS.doctor}/digest`}>AMBER digest</NavLink>
        </nav>
        <p
          className="doctor-header__live dashboard__live"
          role="status"
          aria-live="polite"
          data-live-status={live.mode === 'sse' ? live.status : live.mode}
        >
          {statusText ? (
            <>
              <span className="dashboard__live-dot" aria-hidden="true" />
              {statusText}
            </>
          ) : null}
        </p>
        <div className="doctor-header__user">
          {user ? (
            <p>
              {user.full_name}{' '}
              <span className="doctor-header__role">{readOnly ? 'ANM – read-only' : 'Doctor'}</span>
            </p>
          ) : null}
          <button
            type="button"
            className="btn"
            onClick={() => {
              logout();
              navigate(LOGIN_PATH, { replace: true });
            }}
          >
            Log out
          </button>
        </div>
      </header>
      <main id="doctor-main" tabIndex={-1}>
        <Routes>
          <Route index element={<DashboardPage live={live} />} />
          <Route path="mother/:id" element={<PatientDetail live={live} />} />
          <Route path="digest" element={<DigestPage live={live} />} />
          <Route path="*" element={<Navigate to={AREA_PATHS.doctor} replace />} />
        </Routes>
      </main>
    </div>
  );
}
