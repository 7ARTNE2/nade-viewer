import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type Locale = "en" | "ru";

type I18nValue = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  tr: (english: string, russian: string) => string;
  count: (value: number, englishOne: string, englishMany: string, russianOne: string, russianFew: string, russianMany: string) => string;
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

  const count = (value: number, englishOne: string, englishMany: string, russianOne: string, russianFew: string, russianMany: string) => {
    if (locale === "en") return `${value} ${value === 1 ? englishOne : englishMany}`;
    const mod10 = value % 10;
    const mod100 = value % 100;
    const word = value % 1 !== 0 || mod10 === 0 || mod10 >= 5 || (mod100 >= 11 && mod100 <= 14) ? russianMany : mod10 === 1 ? russianOne : russianFew;
    return `${value} ${word}`;
  };
  return <I18nContext.Provider value={{ locale, setLocale, tr: (english, russian) => locale === "ru" ? russian : english, count }}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n must be used inside I18nProvider");
  return value;
}
