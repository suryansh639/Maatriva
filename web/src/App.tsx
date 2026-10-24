/**
 * App shell and routing (Req 36.6, 37.2–37.4).
 *
 * Routes:
 * - `/login`
 * - `/field/*`  ASHA: `FieldArea` (per-user Dexie db, SyncProvider, FieldLayout and
 *   the field screens), wrapped in the field I18nProvider (Req 32.3). An ASHA with
 *   an expired token stays in (`usable`) and works locally (Req 37.5).
 * - `/doctor/*` doctor and ANM, lazy-loaded so charting and map code stays out of
 *   the field bundle's initial load (Req 36.6)
 * - `/admin`    admin placeholder (Req 37.3)
 * - `/` and unknown paths redirect by role
 *
 * Opening another role's area redirects to the user's own area (Req 37.4).
 */
import { Suspense, lazy } from 'react';
import type { ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import AdminPlaceholder from './admin/AdminPlaceholder';
import FieldArea from './field/FieldArea';
import LoginPage from './login/LoginPage';
import { AuthProvider, useAuth } from './shared/auth';
import { I18nProvider } from './shared/I18nProvider';
import { ToastProvider } from './shared/Toasts';
import { LOGIN_PATH, canAccessArea, homeRouteForRole } from './shared/routes';
import type { Area } from './shared/routes';

const DoctorArea = lazy(() => import('./doctor/DoctorPlaceholder'));

/** Renders `children` only for a usable session whose role may open `area`. */
function RequireArea({ area, children }: { area: Area; children: ReactNode }) {
  const { session, usable } = useAuth();
  const location = useLocation();

  if (!session || !usable) {
    return <Navigate to={LOGIN_PATH} replace state={{ from: location.pathname }} />;
  }
  if (!canAccessArea(session.user.role, area)) {
    return <Navigate to={homeRouteForRole(session.user.role)} replace />;
  }
  return <>{children}</>;
}

function RoleRedirect() {
  const { session, usable } = useAuth();
  if (!session || !usable) return <Navigate to={LOGIN_PATH} replace />;
  return <Navigate to={homeRouteForRole(session.user.role)} replace />;
}

function Loading() {
  return (
    <p className="page-loading" role="status">
      Loading…
    </p>
  );
}

export function AppRoutes() {
  return (
    <Routes>
      <Route
        path={LOGIN_PATH}
        element={
          <I18nProvider>
            <LoginPage />
          </I18nProvider>
        }
      />
      <Route
        path="/field/*"
        element={
          <RequireArea area="field">
            <I18nProvider>
              <FieldArea />
            </I18nProvider>
          </RequireArea>
        }
      />
      <Route
        path="/doctor/*"
        element={
          <RequireArea area="doctor">
            <Suspense fallback={<Loading />}>
              <DoctorArea />
            </Suspense>
          </RequireArea>
        }
      />
      <Route
        path="/admin/*"
        element={
          <RequireArea area="admin">
            <AdminPlaceholder />
          </RequireArea>
        }
      />
      <Route path="*" element={<RoleRedirect />} />
    </Routes>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <ToastProvider>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </ToastProvider>
    </AuthProvider>
  );
}
