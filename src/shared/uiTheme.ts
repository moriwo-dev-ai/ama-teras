/**
 * M27-6(T6・土台のみ): UIテーマの宣言的データ化。
 * テーマ(配色)を**コードではなくJSONデータ**として定義・検証・CSS化する。
 * REGISTRY_DESIGN.md の3層流通モデル「UIの見た目=宣言的データとして共有(実行リスクゼロ)」の布石。
 *
 * デスクトップUIは Tailwind の zinc 系クラス直書きのため、ライトテーマ(styles.css)と
 * 同じ「[data-theme] スコープでユーティリティクラスを上書きする」方式でCSSを生成する。
 * 今夜は土台のみ: 主要スロット(背景・枠線・文字・アクセント)を覆う。
 * 透明度サフィックス等の細部エイリアスの網羅はフェーズ3(見た目共有の本実装)で拡充する。
 */

export const UI_THEME_SLOTS = [
  'bgDeep', // 最も奥まった面(zinc-950/900)
  'bgPanel', // パネル面(zinc-800)
  'bgRaised', // 持ち上がった面(zinc-700)
  'bgHover', // 汎用ホバー(hover:bg-zinc-900/800/700)
  'border', // 枠線(border-zinc-800/700/600)
  'textMain', // 主要文字(text-zinc-100/200/300)
  'textSub', // 補助文字(text-zinc-400/500)
  'accent', // 主要ボタン地(bg-blue-600/500)
  'accentText', // 主要ボタン文字
] as const;

export type UiThemeSlot = (typeof UI_THEME_SLOTS)[number];

export interface UiThemeData {
  name: string;
  /** 未指定スロットの既定値をどちらの標準テーマから採るか */
  base: 'dark' | 'light';
  colors: Partial<Record<UiThemeSlot, string>>;
}

/** 値は16進カラーのみ(CSSインジェクション防止。rgb()等は将来必要になったら追加) */
const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

const DARK_DEFAULTS: Record<UiThemeSlot, string> = {
  bgDeep: '#09090b',
  bgPanel: '#27272a',
  bgRaised: '#3f3f46',
  bgHover: '#3f3f46',
  border: '#52525b',
  textMain: '#f4f4f5',
  textSub: '#a1a1aa',
  accent: '#2563eb',
  accentText: '#ffffff',
};

/** styles.css のライトテーマ(M25-5承認済み配色)と同じ値 */
const LIGHT_DEFAULTS: Record<UiThemeSlot, string> = {
  bgDeep: '#ffffff',
  bgPanel: '#f9f9f8',
  bgRaised: '#ececea',
  bgHover: '#f0eee9',
  border: '#e9e7e1',
  textMain: '#2c2c2a',
  textSub: '#6b6b6b',
  accent: '#1f1e1d',
  accentText: '#ffffff',
};

export type UiThemeParseResult =
  | { ok: true; theme: UiThemeData }
  | { ok: false; errors: string[] };

export function parseUiTheme(raw: unknown): UiThemeParseResult {
  const errors: string[] = [];
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, errors: ['テーマがオブジェクトではない'] };
  }
  const rec = raw as Record<string, unknown>;
  const name = rec['name'];
  if (typeof name !== 'string' || name.trim() === '' || name.length > 40) {
    errors.push('name は1〜40文字の文字列であること');
  }
  const base = rec['base'];
  if (base !== 'dark' && base !== 'light') {
    errors.push("base は 'dark' か 'light' であること");
  }
  const colorsRaw = rec['colors'];
  const colors: Partial<Record<UiThemeSlot, string>> = {};
  if (typeof colorsRaw !== 'object' || colorsRaw === null) {
    errors.push('colors はオブジェクトであること');
  } else {
    for (const [k, v] of Object.entries(colorsRaw)) {
      if (!(UI_THEME_SLOTS as readonly string[]).includes(k)) {
        errors.push(`colors.${k} は未知のスロット(使用可能: ${UI_THEME_SLOTS.join(', ')})`);
        continue;
      }
      if (typeof v !== 'string' || !HEX_COLOR_RE.test(v)) {
        errors.push(`colors.${k} は16進カラー(#rgb / #rrggbb / #rrggbbaa)であること`);
        continue;
      }
      colors[k as UiThemeSlot] = v;
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, theme: { name: (name as string).trim(), base: base as 'dark' | 'light', colors } };
}

/** 未指定スロットを base 既定で補完した実効パレット */
export function resolvePalette(theme: UiThemeData): Record<UiThemeSlot, string> {
  const defaults = theme.base === 'light' ? LIGHT_DEFAULTS : DARK_DEFAULTS;
  return { ...defaults, ...theme.colors };
}

/**
 * [data-theme='custom'] スコープのCSSを生成する。値は parseUiTheme 検証済みの
 * 16進カラーのみが入る前提(＝データ由来のCSSインジェクション不可)
 */
export function uiThemeCss(theme: UiThemeData): string {
  const p = resolvePalette(theme);
  const s = (sel: string) =>
    sel
      .split(',')
      .map((c) => `[data-theme='custom'] ${c.trim()}`)
      .join(',\n');
  return `/* AMA-teras custom theme: ${theme.name.replaceAll('*/', '')} */
[data-theme='custom'] { color-scheme: ${theme.base}; }
${s('.bg-zinc-950, .bg-zinc-900, .bg-zinc-950\\/50, .bg-zinc-900\\/60')} { background-color: ${p.bgDeep}; }
${s('.bg-zinc-800, .bg-zinc-800\\/80, .\\[\\&_th\\]\\:bg-zinc-800 th')} { background-color: ${p.bgPanel}; }
${s('.bg-zinc-700, .bg-zinc-700\\/70, .\\[\\&_th\\]\\:bg-zinc-700 th')} { background-color: ${p.bgRaised}; }
${s('.hover\\:bg-zinc-900:hover, .hover\\:bg-zinc-800:hover, .hover\\:bg-zinc-700:hover')} { background-color: ${p.bgHover}; }
${s('.border-zinc-800, .border-zinc-700, .border-zinc-700\\/60, .border-zinc-600')} { border-color: ${p.border}; }
${s('.text-zinc-100, .text-zinc-200, .text-zinc-300')} { color: ${p.textMain}; }
${s('.text-zinc-400, .text-zinc-500')} { color: ${p.textSub}; }
${s('.bg-blue-600, .bg-blue-500')} { background-color: ${p.accent}; color: ${p.accentText}; }
`;
}
