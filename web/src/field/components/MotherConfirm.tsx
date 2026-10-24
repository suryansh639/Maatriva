/**
 * Mother identity check before saving a device reading (Req 30.3–30.5).
 *
 * `MotherConfirm` is a full-screen `role="dialog"` with `aria-modal`: an initials
 * avatar, name, guardian, village, Short_Code and GA, and two large buttons,
 * "Yes, this is {name}" and "No, wrong mother". Escape counts as "No".
 *
 * `MotherPicker` is the "Choose another mother" dialog: a searchable list of the
 * other active mothers on this phone. Picking one hands its id back to the visit
 * screen, which moves the unsaved reading there.
 *
 * Both dialogs move focus to their title on open, keep Tab inside the dialog, and
 * return focus to the element that opened them on close.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { useI18n } from '../../shared/I18nProvider';
import type { LocalMother } from '../../shared/types';
import { searchMothers, shortCode, sortMothers } from '../mothersList';
import type { VillageNames } from '../mothersList';
import { gaToday } from '../screens/MothersList';
import { initials } from '../visitForm';
import './visit.css';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface FullScreenDialogProps {
  titleId: string;
  title: string;
  onEscape: () => void;
  testId: string;
  children: ReactNode;
}

/** Full-screen modal shell with focus management. */
function FullScreenDialog({ titleId, title, onEscape, testId, children }: FullScreenDialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    headingRef.current?.focus();
    return () => {
      if (opener && opener.isConnected) opener.focus();
    };
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onEscape();
      return;
    }
    if (e.key !== 'Tab' || !ref.current) return;
    const items = Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === headingRef.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      ref={ref}
      className="fullscreen-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      data-testid={testId}
      onKeyDown={onKeyDown}
    >
      <div className="fullscreen-dialog__body">
        <h2 id={titleId} ref={headingRef} tabIndex={-1} className="fullscreen-dialog__title">
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------- confirm

export interface MotherConfirmProps {
  mother: Pick<LocalMother, 'id' | 'full_name' | 'guardian_name' | 'lmp_date'>;
  villageName: string;
  /** "Yes, this is {name}". */
  onConfirm: () => void;
  /** "No, wrong mother" (or Escape): back to the visit without saving. */
  onReject: () => void;
  /** Disables the buttons while the save runs. */
  busy?: boolean;
}

export function MotherConfirm({ mother, villageName, onConfirm, onReject, busy }: MotherConfirmProps) {
  const { t } = useI18n();
  const id = useId();
  const ga = gaToday(mother.lmp_date);

  return (
    <FullScreenDialog
      titleId={`${id}-title`}
      title={t('field.confirm.title')}
      onEscape={() => {
        if (!busy) onReject();
      }}
      testId="mother-confirm"
    >
      <p>{t('field.confirm.body')}</p>
      <div className="mother-confirm__card">
        <span className="mother-confirm__avatar" aria-hidden="true">
          {initials(mother.full_name)}
        </span>
        <div>
          <p className="mother-confirm__name">{mother.full_name}</p>
          <p>{t('field.mothers.guardian', { name: mother.guardian_name })}</p>
          {villageName ? <p>{villageName}</p> : null}
          <p>
            <span className="mono">{t('field.confirm.code', { code: shortCode(mother.id) })}</span>
          </p>
          {ga ? <p>{t('field.confirm.ga', { ga })}</p> : null}
        </div>
      </div>
      <div className="mother-confirm__actions">
        <button
          type="button"
          className="btn btn--primary btn--large"
          data-testid="confirm-yes"
          disabled={busy}
          onClick={onConfirm}
        >
          <span aria-hidden="true">✓ </span>
          {t('field.confirm.yes', { name: mother.full_name })}
        </button>
        <button
          type="button"
          className="btn btn--large"
          data-testid="confirm-no"
          disabled={busy}
          onClick={onReject}
        >
          <span aria-hidden="true">✕ </span>
          {t('field.confirm.no')}
        </button>
      </div>
    </FullScreenDialog>
  );
}

// --------------------------------------------------------------------------- picker

export interface MotherPickerProps {
  /** Candidate mothers (the current one and delivered mothers are filtered out). */
  mothers: readonly LocalMother[];
  excludeId: string;
  villages: VillageNames;
  username?: string | null;
  onPick: (motherId: string) => void;
  onCancel: () => void;
}

export function MotherPicker({ mothers, excludeId, villages, username, onPick, onCancel }: MotherPickerProps) {
  const { t } = useI18n();
  const id = useId();
  const [query, setQuery] = useState('');

  const rows = useMemo(() => {
    const candidates = mothers.filter((m) => m.id !== excludeId && m.status !== 'delivered');
    return sortMothers(searchMothers(candidates, query, villages), { username });
  }, [mothers, excludeId, villages, username, query]);

  const villageOf = (villageId: string): string =>
    villages instanceof Map ? (villages.get(villageId) ?? '') : ((villages as Record<string, string>)[villageId] ?? '');

  return (
    <FullScreenDialog titleId={`${id}-title`} title={t('field.confirm.pickerTitle')} onEscape={onCancel} testId="mother-picker">
      <div className="form-field">
        <label htmlFor={`${id}-search`}>{t('field.mothers.searchLabel')}</label>
        <input
          id={`${id}-search`}
          type="search"
          autoComplete="off"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {rows.length === 0 ? (
        <p role="status">{t('field.confirm.pickerEmpty')}</p>
      ) : (
        <ul className="mother-picker__list">
          {rows.map((m) => {
            const ga = gaToday(m.lmp_date);
            const village = villageOf(m.village_id);
            return (
              <li key={m.id}>
                <button
                  type="button"
                  className="btn mother-picker__item"
                  data-testid="picker-mother"
                  data-mother-id={m.id}
                  onClick={() => onPick(m.id)}
                >
                  <span className="mother-picker__name">{m.full_name}</span>
                  <span className="mother-picker__meta">
                    {[village, t('field.confirm.code', { code: shortCode(m.id) }), ga ? t('field.confirm.ga', { ga }) : '']
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <button type="button" className="btn btn--block" onClick={onCancel}>
        {t('field.common.back')}
      </button>
    </FullScreenDialog>
  );
}

export default MotherConfirm;
