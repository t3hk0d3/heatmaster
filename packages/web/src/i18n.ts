import { en } from "./i18n/en.ts";
import { ru } from "./i18n/ru.ts";

export type Language = "en" | "ru";
export const LANGUAGE_KEY = "heatmaster.language";

export type TextKey = keyof typeof en;
export type Dictionary = Readonly<Record<TextKey, string>>;

export const DICTIONARIES: Readonly<Record<Language, Dictionary>> = { en, ru };

export function isLanguage(value: unknown): value is Language {
  return value === "en" || value === "ru";
}

/** The stored choice; else the first browser language that is `en` or `ru`; else `en`. */
export function pickLanguage(stored: string | null, browser: readonly string[]): Language {
  if (isLanguage(stored)) return stored;
  for (const tag of browser) {
    const first = tag.toLowerCase().split("-")[0];
    if (isLanguage(first)) return first;
  }
  return "en";
}

export type Translate = (
  key: TextKey,
  params?: Readonly<Record<string, string | number>>,
) => string;

/** Replaces `{name}` places with the params. A place with no param stays as written. */
export function translator(language: Language): Translate {
  const dictionary = DICTIONARIES[language];
  return (key, params) => {
    const text = Object.hasOwn(dictionary, key) ? dictionary[key] : key;
    if (params === undefined) return text;
    return text.replace(/\{(\w+)\}/g, (place, name: string) =>
      Object.hasOwn(params, name) ? String(params[name]) : place,
    );
  };
}

export function isTextKey(key: string): key is TextKey {
  return Object.hasOwn(en, key);
}

/** The text of `<prefix>.<code>`; a code with no text is shown as it is. */
export function codeText(t: Translate, prefix: string, code: string): string {
  const key = `${prefix}.${code}`;
  return isTextKey(key) ? t(key) : code;
}
