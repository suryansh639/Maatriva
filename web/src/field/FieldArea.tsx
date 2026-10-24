/**
 * The `/field/*` area (Req 26.1, 28, 37.5, 37.7).
 *
 * Opens the signed-in ASHA's own Dexie database (`maatriva-field-<userId>`), runs
 * one `SyncProvider` for it and mounts `FieldLayout` with the field screens:
 *
 *   /field                         MothersList
 *   /field/register                RegisterMother
 *   /field/mother/:motherId        MotherDetail
 *   /field/mother/:motherId/visit  NewVisit
 *   /field/tasks                   TasksInbox
 *   /field/sync-errors             SyncErrors
 *   anything else                  "Page not found" with a link to the list
 *
 * The area is keyed by user id, so a different sign-in gets a fresh provider and
 * database. Leaving the area (logout) releases the handle; it is closed a tick
 * later, after the screens' live queries have unsubscribed. The data is never
 * deleted (Req 37.7). An expired token keeps the area open for local work; the
 * badge then shows "Sign in to sync" (Req 37.5).
 */
import { useEffect, useMemo } from 'react';
import { Link, Route, Routes } from 'react-router-dom';

import { useAuth } from '../shared/auth';
import { useI18n } from '../shared/I18nProvider';
import { openFieldDb, retainFieldDb } from './db';
import { FieldLayout } from './FieldLayout';
import { FIELD_PATHS } from './paths';
import { MotherDetail } from './screens/MotherDetail';
import { MothersList } from './screens/MothersList';
import { NewVisit } from './screens/NewVisit';
import { RegisterMother } from './screens/RegisterMother';
import { SyncErrors } from './screens/SyncErrors';
import { TasksInbox } from './screens/TasksInbox';
import { SyncProvider } from './sync/SyncProvider';

function FieldNotFound() {
  const { t } = useI18n();
  return (
    <section className="field-screen" aria-labelledby="field-not-found">
      <h1 id="field-not-found">{t('field.error.notFound')}</h1>
      <p>
        <Link to={FIELD_PATHS.mothers} className="field-btn">
          {t('field.nav.mothers')}
        </Link>
      </p>
    </section>
  );
}

/** The field routes, rendered inside `SyncProvider` (relative to `/field/*`). */
export function FieldRoutes() {
  return (
    <Routes>
      <Route element={<FieldLayout />}>
        <Route index element={<MothersList />} />
        <Route path="register" element={<RegisterMother />} />
        <Route path="mother/:motherId" element={<MotherDetail />} />
        <Route path="mother/:motherId/visit" element={<NewVisit />} />
        <Route path="tasks" element={<TasksInbox />} />
        <Route path="sync-errors" element={<SyncErrors />} />
        <Route path="*" element={<FieldNotFound />} />
      </Route>
    </Routes>
  );
}

function UserFieldArea({ userId }: { userId: string }) {
  const db = useMemo(() => openFieldDb(userId), [userId]);
  useEffect(() => retainFieldDb(db), [db]);

  return (
    <SyncProvider db={db}>
      <FieldRoutes />
    </SyncProvider>
  );
}

export function FieldArea() {
  const { user } = useAuth();
  // `RequireArea` only renders this for an ASHA session.
  if (!user) return null;
  return <UserFieldArea key={user.id} userId={user.id} />;
}

export default FieldArea;
