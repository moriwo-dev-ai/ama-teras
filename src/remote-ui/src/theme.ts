/** テーマ切替(ダーク/ライト)。localStorage に保存し、<html data-theme> で styles.css の上書きを切り替える */
export type Theme = 'dark' | 'light';

const KEY = 'amateras-theme';

export function loadTheme(): Theme {
  try {
    return localStorage.getItem(KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset['theme'] = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* プライベートブラウズ等で保存できなくても表示は切り替える */
  }
}
