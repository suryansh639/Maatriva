/** `/admin` placeholder (Req 37.3). The district census is a roadmap item. */
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../shared/auth';
import { LOGIN_PATH } from '../shared/routes';

export default function AdminPlaceholder() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  return (
    <main className="staff-area placeholder-page">
      <h1>Admin view not built in MVP</h1>
      {user ? <p>Signed in as {user.full_name}.</p> : null}
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
