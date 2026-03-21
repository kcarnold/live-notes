import { strings, SUPPORTED_LOCALES, LANGUAGE_BCP47, type SupportedLocale } from './strings';
export { LANGUAGE_BCP47 };

let _resolvedLocale: SupportedLocale | null = null;

export function resolveLocale(): SupportedLocale {
  if (_resolvedLocale) return _resolvedLocale;

  let locale: SupportedLocale = 'en';
  const urlLocale = new URLSearchParams(window.location.search).get('locale');
  if (urlLocale && (SUPPORTED_LOCALES as string[]).includes(urlLocale)) {
    locale = urlLocale as SupportedLocale;
  } else {
    for (const lang of navigator.languages) {
      const base = lang.split('-')[0];
      if ((SUPPORTED_LOCALES as string[]).includes(base)) {
        locale = base as SupportedLocale;
        break;
      }
    }
  }

  // Set <html lang> to match the resolved locale
  document.documentElement.lang = locale;
  _resolvedLocale = locale;
  return locale;
}

export function useStrings() {
  return strings[resolveLocale()];
}
