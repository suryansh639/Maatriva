/**
 * Sync status and rejected changes (Req 28.3), opened from the sync badge.
 *
 * - A summary: the badge text, the pending count, the last sync time and "Sync now".
 * - The rejected changes from `syncErrors`, newest first. Each shows the entity,
 *   the record's short code, the translated code label with the raw code, the
 *   server's message and when it was stored. "Remove" deletes one entry from the
 *   list (the server never accepted it, so nothing else changes).
 */
import { useI18n } from '../../shared/I18nProvider';
import { formatIstHHMM, istDate, parseIsoZ } from '../../shared/time';
import type { SyncErrorEntry } from '../db';
import { shortCode } from '../mothersList';
import { badgeText } from '../sync/badge';
import { useSync } from '../sync/SyncProvider';

function formatWhen(iso: string): string {
  const ms = parseIsoZ(iso);
  const t = Number.isNaN(ms) ? Date.parse(iso) : ms;
  return Number.isNaN(t) ? iso : `${istDate(t)} ${formatIstHHMM(t)}`;
}

function entityKey(entity: string) {
  if (entity === 'mother') return 'sync.entity.mother' as const;
  if (entity === 'visit') return 'sync.entity.visit' as const;
  if (entity === 'task') return 'sync.entity.task' as const;
  return null;
}

export function SyncErrors() {
  const { t, syncCodeLabel } = useI18n();
  const { db, badge, status, pendingCount, syncErrors, syncNow, simulatedOffline } = useSync();

  const remove = async (entry: SyncErrorEntry) => {
    if (entry.id === undefined) return;
    try {
      await db.syncErrors.delete(entry.id);
    } catch (err) {
      console.warn('could not remove sync error', err);
    }
  };

  const offline = simulatedOffline || !status.online;

  return (
    <section className="field-screen sync-errors" aria-labelledby="sync-errors-title">
      <h1 id="sync-errors-title">{t('field.syncErrors.title')}</h1>

      <div className="sync-summary">
        <p>
          <span aria-hidden="true">{badge.icon} </span>
          {badgeText(badge, t)}
        </p>
        <p>{t('sync.badge.pending', { n: pendingCount })}</p>
        {status.lastSyncAt ? (
          <p>{t('sync.lastSync', { time: formatWhen(status.lastSyncAt) })}</p>
        ) : null}
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => void syncNow()}
          disabled={status.syncing || offline}
        >
          <span aria-hidden="true">⟳ </span>
          {t('sync.now')}
        </button>
      </div>

      {syncErrors.length === 0 ? (
        <p className="sync-errors__empty">{t('field.syncErrors.empty')}</p>
      ) : (
        <>
          <p>{t('field.syncErrors.intro')}</p>
          <ul className="sync-errors__list">
            {syncErrors.map((e) => {
              const key = entityKey(String(e.entity));
              const headId = `sync-error-${e.id ?? e.created_at}`;
              return (
                <li key={e.id ?? `${e.entity_id}-${e.created_at}`} className="sync-errors__item">
                  <p className="sync-errors__head" id={headId}>
                    <strong>{key ? t(key) : String(e.entity)}</strong>
                    {e.entity_id ? <span className="sync-errors__code"> {shortCode(e.entity_id)}</span> : null}
                  </p>
                  <p className="sync-errors__reason">
                    {syncCodeLabel(e.code)} <span>({t('field.syncErrors.code', { code: e.code })})</span>
                  </p>
                  {e.message ? (
                    <p className="sync-errors__message" lang="en">
                      {e.message}
                    </p>
                  ) : null}
                  <p className="sync-errors__when">
                    <time dateTime={e.created_at}>{formatWhen(e.created_at)}</time>
                  </p>
                  <button
                    type="button"
                    className="btn"
                    aria-describedby={headId}
                    onClick={() => void remove(e)}
                  >
                    {t('field.syncErrors.remove')}
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}

export default SyncErrors;
