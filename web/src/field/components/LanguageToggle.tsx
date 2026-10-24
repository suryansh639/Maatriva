/**
 * English / Hindi toggle (Req 32.3).
 *
 * A labelled group of two buttons with `aria-pressed`; each shows its language's
 * native name and carries a matching `lang` attribute. `I18nProvider` persists the
 * choice in `localStorage['maatriva.lang']` and sets `<html lang>`.
 */
import { useI18n } from '../../shared/I18nProvider';
import { LANGS, LANG_NAMES } from '../../shared/i18n';

export function LanguageToggle() {
  const { lang, setLang, t } = useI18n();

  return (
    <div className="lang-toggle" role="group" aria-label={t('field.lang.label')}>
      {LANGS.map((l) => (
        <button
          key={l}
          type="button"
          lang={l}
          className={l === lang ? 'lang-toggle__btn lang-toggle__btn--active' : 'lang-toggle__btn'}
          aria-pressed={l === lang}
          data-testid={`lang-${l}`}
          onClick={() => setLang(l)}
        >
          {LANG_NAMES[l]}
        </button>
      ))}
    </div>
  );
}

export default LanguageToggle;
