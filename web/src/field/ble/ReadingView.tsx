/**
 * One scale reading: raw 0x2A9D hex (monospace) and the parsed kilograms, or
 * the parse error / "Implausible reading – weigh again" (Req 33.11, 34.7, 35.3).
 */
import { useI18n } from '../../shared/I18nProvider';
import type { ScaleReading } from './scale';
import './scale.css';

export default function ReadingView({ reading }: { reading: ScaleReading }) {
  const { t } = useI18n();
  const { result } = reading;
  return (
    <div>
      <p>
        {t('field.scale.rawHex')}: <code className="scale-hex">{reading.rawHex || '—'}</code>
      </p>
      {result.ok ? (
        <p className="scale-kg">{t('field.scale.parsedKg', { w: result.weightKg.toFixed(2) })}</p>
      ) : (
        <p className="form-error">{t('field.scale.parseError', { code: result.error })}</p>
      )}
      {result.ok && !reading.plausible ? (
        <p className="form-error">{t('field.scale.implausible')}</p>
      ) : null}
    </div>
  );
}
