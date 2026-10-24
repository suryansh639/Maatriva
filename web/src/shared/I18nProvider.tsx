/**
 * Language context for the field area (Req 32.3).
 *
 * - Defaults to English when `localStorage['maatriva.lang']` is unset.
 * - Persists every change to `maatriva.lang` and mirrors it to `<html lang>`.
 * - `useI18n()` outside a provider returns an English-only value, so shared
 *   components also render in the (English-only) doctor area and in tests.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  DEFAULT_LANG,
  actionLabel,
  flagLabel,
  readStoredLang,
  riskLabel,
  storeLang,
  syncCodeLabel,
  translate,
} from './i18n';
import type { InterpolationVars, Lang, MessageKey } from './i18n';

export interface I18nContextValue {
  lang: Lang;
  setLang: (lang: Lang) => void;
  toggleLang: () => void;
  t: (key: MessageKey, vars?: InterpolationVars) => string;
  flagLabel: (code: string) => string;
  actionLabel: (code: string) => string;
  riskLabel: (level: string) => string;
  syncCodeLabel: (code: string) => string;
}

function buildValue(lang: Lang, setLang: (lang: Lang) => void): I18nContextValue {
  return {
    lang,
    setLang,
    toggleLang: () => setLang(lang === 'en' ? 'hi' : 'en'),
    t: (key, vars) => translate(lang, key, vars),
    flagLabel: (code) => flagLabel(lang, code),
    actionLabel: (code) => actionLabel(lang, code),
    riskLabel: (level) => riskLabel(lang, level),
    syncCodeLabel: (code) => syncCodeLabel(lang, code),
  };
}

const englishOnly = buildValue(DEFAULT_LANG, () => {});

const I18nContext = createContext<I18nContextValue>(englishOnly);

export interface I18nProviderProps {
  children: ReactNode;
  /** Overrides the stored language for the first render (tests, previews). */
  initialLang?: Lang;
}

export function I18nProvider({ children, initialLang }: I18nProviderProps) {
  const [lang, setLangState] = useState<Lang>(() => initialLang ?? readStoredLang());

  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.lang = lang;
    }
  }, [lang]);

  const setLang = useCallback((next: Lang) => {
    storeLang(next);
    setLangState(next);
  }, []);

  const value = useMemo(() => buildValue(lang, setLang), [lang, setLang]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}

/** Shorthand for components that only need `t`. */
export function useT(): I18nContextValue['t'] {
  return useContext(I18nContext).t;
}
