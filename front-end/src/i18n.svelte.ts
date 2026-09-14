import { getContext, setContext } from "svelte";
import { resolveLocale, translate, type Locale } from "./i18n";

export type I18nContext = {
  readonly locale: Locale;
  readonly setLocale: (locale: Locale) => void;
  readonly toggleLocale: () => void;
  readonly t: (key: string, values?: Readonly<Record<string, string | number>>) => string;
};

export const I18N_CONTEXT_KEY = Symbol("nnmodelling-i18n");
const STORAGE_KEY = "nnmodelling-language";

function readStoredLocale(): Locale {
  try {
    return resolveLocale(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return "en";
  }
}

export function createI18n(): I18nContext {
  class I18nState implements I18nContext {
    locale = $state<Locale>(readStoredLocale());

    constructor() {
      document.documentElement.lang = this.locale;
    }

    setLocale = (next: Locale): void => {
      this.locale = next;
      document.documentElement.lang = next;
      try {
        window.localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // The in-memory language still works when browser storage is unavailable.
      }
    };

    toggleLocale = (): void => this.setLocale(this.locale === "en" ? "it" : "en");

    t = (key: string, values?: Readonly<Record<string, string | number>>): string =>
      translate(this.locale, key, values);
  }

  return new I18nState();
}

export function provideI18n(context: I18nContext): void {
  setContext(I18N_CONTEXT_KEY, context);
}

const fallback: I18nContext = {
  locale: "en",
  setLocale: () => undefined,
  toggleLocale: () => undefined,
  t: (key, values) => translate("en", key, values),
};

export function useI18n(): I18nContext {
  return getContext<I18nContext>(I18N_CONTEXT_KEY) ?? fallback;
}
