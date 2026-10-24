/**
 * Sign-in page (Req 5.3, 37.2, 37.6, 38.1).
 *
 * - Labelled username and password inputs.
 * - "Internet needed for first sign-in" while offline with no cached session.
 * - On success, goes to the originally requested page when the role may open it,
 *   otherwise to the role's home area.
 * - A usable session with a working token skips the form. An ASHA whose token
 *   expired ("Sign in to sync") gets the form plus a link back to local work; the
 *   cached session stays until the new login replaces it (Req 37.5).
 */
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { isApiError } from '../shared/api';
import { loginMode, useAuth } from '../shared/auth';
import { useT } from '../shared/I18nProvider';
import type { MessageKey } from '../shared/i18n';
import { homeRouteForRole, postLoginRoute } from '../shared/routes';

function useOnline(): boolean {
  const [online, setOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  return online;
}

interface LocationState {
  from?: string;
}

export default function LoginPage() {
  const t = useT();
  const { session, usable, tokenExpired, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const online = useOnline();
  // Re-sign-in after expiry: prefill the cached user's name.
  const [username, setUsername] = useState(() => (session && tokenExpired ? session.user.username : ''));
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorKey, setErrorKey] = useState<MessageKey | null>(null);

  const mode = loginMode(session, usable, tokenExpired);
  if (mode === 'redirect' && session) {
    return <Navigate to={homeRouteForRole(session.user.role)} replace />;
  }

  const from = (location.state as LocationState | null)?.from ?? null;
  // "Sign in to sync": the expired ASHA session stays until this login replaces it.
  const resumeTo = mode === 'reauth' && session ? postLoginRoute(session.user.role, from) : null;
  const offlineNoSession = !online && session === null;
  const canSubmit = !submitting && username.trim() !== '' && password !== '';

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setErrorKey(null);
    try {
      const user = await login(username.trim(), password);
      navigate(postLoginRoute(user.role, from), { replace: true });
    } catch (err) {
      if (isApiError(err) && err.status === 401) {
        setErrorKey('field.login.invalid');
      } else if (!navigator.onLine) {
        setErrorKey('field.login.offlineFirst');
      } else {
        setErrorKey('field.login.failed');
      }
      setSubmitting(false);
    }
  };

  return (
    <main className="login-page">
      <h1 className="login-page__brand">{t('field.app.name')}</h1>
      <p className="login-page__note">{t('field.app.synthetic')}</p>
      <form className="login-form" onSubmit={onSubmit} noValidate aria-describedby="login-status">
        <h2>{t('field.login.title')}</h2>
        {resumeTo ? <p className="login-form__note">{t('field.login.expired')}</p> : null}
        <div className="form-field">
          <label htmlFor="login-username">{t('field.login.username')}</label>
          <input
            id="login-username"
            name="username"
            type="text"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            required
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </div>
        <div className="form-field">
          <label htmlFor="login-password">{t('field.login.password')}</label>
          <input
            id="login-password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <div id="login-status" role="status" aria-live="polite" className="login-form__status">
          {offlineNoSession ? <p className="form-error">{t('field.login.offlineFirst')}</p> : null}
          {errorKey && !(offlineNoSession && errorKey === 'field.login.offlineFirst') ? (
            <p className="form-error">{t(errorKey)}</p>
          ) : null}
        </div>
        <button type="submit" className="btn btn--primary" disabled={!canSubmit}>
          {submitting ? t('field.login.signingIn') : t('field.login.submit')}
        </button>
        {resumeTo ? (
          <p className="login-form__resume">
            <Link to={resumeTo} replace data-testid="login-continue-offline">
              {t('field.login.continueOffline')}
            </Link>
          </p>
        ) : null}
      </form>
    </main>
  );
}
