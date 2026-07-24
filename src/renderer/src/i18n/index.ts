import { create } from 'zustand';
import { ja, type MessageKey } from './ja';
import { en } from './en';

export type { MessageKey } from './ja';

/**
 * M100-1: UI表示言語の最小i18n。
 * - 既定は 'auto'(OSロケールがja*なら日本語、それ以外は英語)
 * - 文言は t('key') / useT()('key') で引く。{name} プレースホルダを params で置換
 * - 外部ライブラリなし(依存追加は最小限の作業ルールに従う)
 */
export type UiLang = 'ja' | 'en';

const dicts: Record<UiLang, Record<MessageKey, string>> = { ja, en };

interface I18nState {
  lang: UiLang;
  setLang: (lang: UiLang) => void;
}

export const useI18nStore = create<I18nState>((set) => ({
  lang: 'ja',
  setLang: (lang) => set({ lang }),
}));

/** 設定値('auto'|'ja'|'en'|未設定)とOSロケールから実言語を決める */
export function resolveLang(pref: 'auto' | 'ja' | 'en' | undefined, osLocale: string): UiLang {
  if (pref === 'ja' || pref === 'en') return pref;
  return osLocale.toLowerCase().startsWith('ja') ? 'ja' : 'en';
}

/** プレースホルダ置換。未知の {name} はそのまま残す(欠落に気付けるように) */
function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in params ? String(params[name]) : whole,
  );
}

/** 非フック版(イベントハンドラ・ストア内など)。コンポーネント本体では useT() を使うこと */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  return interpolate(dicts[useI18nStore.getState().lang][key], params);
}

/** フック版: 言語切替で再レンダーされる */
export function useT(): typeof t {
  useI18nStore((s) => s.lang);
  return t;
}
