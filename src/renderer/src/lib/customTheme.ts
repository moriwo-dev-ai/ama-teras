import { parseUiTheme, uiThemeCss, type UiThemeData } from '../../../shared/uiTheme';
import { applyThemePref } from './themePref';

/**
 * M27-6(T6・土台): JSONで定義したカスタムテーマの適用・解除。
 * 適用中は <html data-theme="custom"> + <style id="ama-custom-theme"> で
 * 生成CSS(uiThemeCss)を注入する。JSONは localStorage に保存し、起動時に復元する。
 * 将来「見た目の共有=宣言的データの流通」(REGISTRY_DESIGN.md)の受け口になる
 */

const STORAGE_KEY = 'amateras-custom-theme-json';
const STYLE_ID = 'ama-custom-theme';

function inject(theme: UiThemeData): void {
  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (el === null) {
    el = document.createElement('style');
    el.id = STYLE_ID;
    document.head.appendChild(el);
  }
  el.textContent = uiThemeCss(theme);
  document.documentElement.dataset.theme = 'custom';
}

/** JSON文字列を検証して適用する。成功時は localStorage に保存 */
export function applyCustomThemeJson(json: string): { ok: boolean; message: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { ok: false, message: 'JSONとして不正' };
  }
  const parsed = parseUiTheme(raw);
  if (!parsed.ok) return { ok: false, message: parsed.errors.join(' / ') };
  inject(parsed.theme);
  try {
    localStorage.setItem(STORAGE_KEY, json);
  } catch {
    // 保存不可でも適用自体は有効(次回起動で消えるだけ)
  }
  return { ok: true, message: `カスタムテーマ「${parsed.theme.name}」を適用した` };
}

/** 起動時の復元(保存が壊れていれば静かに標準テーマへ) */
export function applyStoredCustomTheme(): void {
  try {
    const json = localStorage.getItem(STORAGE_KEY);
    if (json === null) return;
    const r = applyCustomThemeJson(json);
    if (!r.ok) localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* localStorage不可なら何もしない */
  }
}

/** カスタムテーマを解除して標準(dark/light設定)へ戻す */
export function clearCustomTheme(): void {
  document.getElementById(STYLE_ID)?.remove();
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* noop */
  }
  applyThemePref();
}

export function storedCustomThemeJson(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}
