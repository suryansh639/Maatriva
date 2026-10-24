/**
 * Temporary lazy `/doctor/*` content until task 21.6 registers `DoctorLayout` and
 * the dashboard routes. English only (Req 32.6).
 */
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../shared/auth';
import { LOGIN_PATH } from '../shared/routes';

export default function DoctorPlaceholder() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  return (
    <main className="staff-area placeholder-page">
      <h1>PHC dashboard</h1>
      {user ? (
        <p>
          Signed in as {user.full_name} ({user.role === 'anm' ? 'ANM, read-only' : 'Doctor'})
          {user.facility_name ? ` – ${user.facility_name}` : ''}.
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
    </main>
  );
}
