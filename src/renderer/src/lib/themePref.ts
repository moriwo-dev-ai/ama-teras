/**
 * M25-4: テーマ設定(ダーク/ライト。renderer限定のUI好みなので localStorage 保存)。
 * <html data-theme="dark|light"> を styles.css のセレクタが参照する。
 * animPref.ts と同じパターン(M16-4)。
 */
const THEME_KEY = 'amateras-theme';

export type Theme = 'dark' | 'light';

export function currentTheme(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

export function applyThemePref(): void {
  document.documentElement.dataset.theme = currentTheme();
}

export function setTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // localStorage不可でも属性は反映する
  }
  document.documentElement.dataset.theme = theme;
}
