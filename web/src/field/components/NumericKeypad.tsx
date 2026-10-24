/**
 * Large numeric keypad for Hb entry (Req 30.1, 30.2; design §16 "Screens").
 *
 * Renders a labelled `<input inputmode="decimal">` (the E2E may fill it directly)
 * plus on-screen keys 0–9, a decimal point, "Delete last digit" and "Clear". The
 * keys edit the same text through `applyKeypadKey`, so the one-decimal limit holds
 * for both. Every key is a real `<button type="button">` at least 48×48 px, with
 * `aria-controls` pointing at the input. Validation messages come from the form
 * and are linked through `describedBy`.
 */
import { useI18n } from '../../shared/I18nProvider';
import { KEYPAD_DIGITS, applyKeypadKey } from './keypad';
import type { KeypadKey } from './keypad';
import './visit.css';

export interface NumericKeypadProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  /** Digits allowed after the point (default 1). */
  maxDecimals?: number;
  maxLength?: number;
  /** Id of the inline error, when shown. */
  describedBy?: string;
  invalid?: boolean;
  /** `data-testid` of the input. */
  testId?: string;
}

export default function NumericKeypad({
  id,
  label,
  value,
  onChange,
  onBlur,
  maxDecimals = 1,
  maxLength = 5,
  describedBy,
  invalid,
  testId,
}: NumericKeypadProps) {
  const { t } = useI18n();

  const press = (key: KeypadKey) => {
    onChange(applyKeypadKey(value, key, { maxDecimals, maxLength }));
    onBlur?.();
  };

  const keyButton = (key: KeypadKey, text: string, ariaLabel?: string, extra = '') => (
    <button
      key={key}
      type="button"
      className={`btn keypad__key ${extra}`}
      aria-controls={id}
      aria-label={ariaLabel}
      data-testid={`keypad-${key}`}
      onClick={() => press(key)}
    >
      {text}
    </button>
  );

  return (
    <div className="keypad">
      <div className="form-field">
        <label htmlFor={id}>{label}</label>
        <input
          id={id}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          className="keypad__input"
          data-testid={testId}
          value={value}
          aria-invalid={invalid ? true : undefined}
          aria-describedby={describedBy}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
        />
      </div>
      <div className="keypad__grid" role="group" aria-label={t('field.keypad.label')}>
        {KEYPAD_DIGITS.map((d) => keyButton(d, d))}
        {keyButton('.', '.', t('field.keypad.decimal'))}
        {keyButton('0', '0')}
        {keyButton('backspace', '⌫', t('field.keypad.backspace'))}
        {keyButton('clear', t('field.keypad.clear'), undefined, 'keypad__key--wide')}
      </div>
    </div>
  );
}
