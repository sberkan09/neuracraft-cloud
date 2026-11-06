// Languages: one JSON file per language in ./locales, English as the fallback. Adding a language is
// adding its file here and in LANGUAGES (and to the API's LOCALES).
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";
import tr from "./locales/tr.json";

export const LANGUAGES = ["en", "tr"] as const;
export type Language = (typeof LANGUAGES)[number];

function initial(): Language {
  try {
    const saved = localStorage.getItem("nc.language");
    if (LANGUAGES.includes(saved as Language)) return saved as Language;
  } catch {
    /* storage may be unavailable */
  }
  const browser = navigator.language.slice(0, 2);
  return LANGUAGES.includes(browser as Language) ? (browser as Language) : "en";
}

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, tr: { translation: tr } },
  lng: initial(),
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

export function setLanguage(l: Language) {
  void i18n.changeLanguage(l);
  document.documentElement.lang = l;
  try {
    localStorage.setItem("nc.language", l);
  } catch {
    /* ignore */
  }
}

document.documentElement.lang = i18n.language;
export default i18n;
