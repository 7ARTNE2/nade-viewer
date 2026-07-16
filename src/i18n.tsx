import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type Locale = "en" | "ru";

type I18nValue = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  tr: (english: string, russian: string) => string;
};

const I18nContext = createContext<I18nValue | null>(null);

function initialLocale(): Locale {
  const stored = window.localStorage.getItem("nadeviewer.locale");
  if (stored === "en" || stored === "ru") return stored;
  return navigator.language.toLowerCase().startsWith("ru") ? "ru" : "en";
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>(initialLocale);

  useEffect(() => {
    window.localStorage.setItem("nadeviewer.locale", locale);
    document.documentElement.lang = locale;
  }, [locale]);

  return <I18nContext.Provider value={{ locale, setLocale, tr: (english, russian) => locale === "ru" ? russian : english }}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n must be used inside I18nProvider");
  return value;
}
