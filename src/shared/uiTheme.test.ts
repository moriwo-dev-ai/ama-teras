import { describe, expect, it } from 'vitest';
import { parseUiTheme, resolvePalette, uiThemeCss } from './uiTheme';

const VALID = {
  name: 'ocean',
  base: 'dark',
  colors: { bgDeep: '#101418', accent: '#0f766e' },
};

describe('M27-6: parseUiTheme(テーマJSONの検証)', () => {
  it('正しいテーマは型付きで返る', () => {
    const r = parseUiTheme(VALID);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.theme.name).toBe('ocean');
  });

  it('未知スロット・不正カラー・不正base をまとめて報告する', () => {
    const r = parseUiTheme({
      name: 'x',
      base: 'sepia',
      colors: { bgDeep: 'red', sidebar: '#fff' },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.includes('base'))).toBe(true);
      expect(r.errors.some((e) => e.includes('16進カラー'))).toBe(true);
      expect(r.errors.some((e) => e.includes('未知のスロット'))).toBe(true);
    }
  });

  it('CSSインジェクションを狙った値(} や url())は16進検証で弾かれる', () => {
    const r = parseUiTheme({
      name: 'evil',
      base: 'dark',
      colors: { bgDeep: '#fff} body { display:none }' },
    });
    expect(r.ok).toBe(false);
  });

  it('name の空文字・41文字以上は拒否', () => {
    expect(parseUiTheme({ ...VALID, name: '' }).ok).toBe(false);
    expect(parseUiTheme({ ...VALID, name: 'a'.repeat(41) }).ok).toBe(false);
  });
});

describe('M27-6: resolvePalette / uiThemeCss', () => {
  it('未指定スロットは base の標準値で補完される', () => {
    const r = parseUiTheme(VALID);
    if (!r.ok) throw new Error('unreachable');
    const p = resolvePalette(r.theme);
    expect(p.bgDeep).toBe('#101418'); // 指定値
    expect(p.bgPanel).toBe('#27272a'); // dark標準
    const light = resolvePalette({ name: 'l', base: 'light', colors: {} });
    expect(light.bgDeep).toBe('#ffffff'); // light標準(styles.cssと同値)
  });

  it('生成CSSは custom スコープで主要クラスを上書きし、指定色が入る', () => {
    const r = parseUiTheme(VALID);
    if (!r.ok) throw new Error('unreachable');
    const css = uiThemeCss(r.theme);
    expect(css).toContain(`[data-theme='custom'] .bg-zinc-950`);
    expect(css).toContain('#101418');
    expect(css).toContain(`color-scheme: dark`);
    // アクセントはボタン文字色もセットで上書き(ライトテーマのM25-6の教訓)
    expect(css).toMatch(/\.bg-blue-600[\s\S]*?background-color: #0f766e; color: #ffffff/);
  });

  it('テーマ名にコメント終端(*/)が入ってもCSSコメントを壊さない', () => {
    const css = uiThemeCss({ name: 'x*/ hack', base: 'dark', colors: {} });
    // 名前中の */ は除去され、先頭行は完結したコメントのまま(早期終端でCSSが漏れない)
    expect(css.split('\n')[0]).toBe('/* AMA-teras custom theme: x hack */');
  });
});
