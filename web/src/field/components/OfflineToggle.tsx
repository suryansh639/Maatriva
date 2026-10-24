/**
 * "Simulate offline" switch (Req 28.4, 27.3, 27.4).
 *
 * A `<button role="switch" aria-checked>` whose visible text is its accessible
 * name. The state lives in `SyncProvider`, which persists it in
 * `localStorage['maatriva.simOffline']`, aborts in-flight requests when turned on
 * and starts a sync cycle when turned off.
 */
import { useId } from 'react';
import { useI18n } from '../../shared/I18nProvider';
import { useSync } from '../sync/SyncProvider';

export function OfflineToggle() {
  const { t } = useI18n();
  const { simulatedOffline, toggleSimulatedOffline } = useSync();
  const hintId = useId();

  return (
    <button
      type="button"
      role="switch"
      aria-checked={simulatedOffline}
      aria-describedby={hintId}
      className={simulatedOffline ? 'field-switch field-switch--on' : 'field-switch'}
      data-testid="simulate-offline"
      onClick={toggleSimulatedOffline}
    >
      <span className="field-switch__track" aria-hidden="true">
        <span className="field-switch__thumb" />
      </span>
      <span className="field-switch__label">{t('field.offline.label')}</span>
      <span id={hintId} className="visually-hidden">
        {t('field.offline.hint')}
      </span>
    </button>
  );
}

export default OfflineToggle;
