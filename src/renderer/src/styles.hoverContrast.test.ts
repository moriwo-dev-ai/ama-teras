import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * M25-6: ライトテーマでボタンにホバーすると背景が黒(濃灰)になり読めなくなるバグの回帰テスト。
 *
 * 原因は2種類あった:
 *  (1) ダーク前提の hover:bg-zinc-800 等がライト上書き対象外で素通りし、暗色のまま残っていた
 *  (2) bg-blue-600 等の塗りボタンが文字色を明示せず body 既定色に頼っており、ボディ既定を
 *      ライト用に反転させた結果、黒背景に黒文字(またはその逆)になっていた
 *
 * どちらも styles.css だけを見れば静的に検出できるため、実ブラウザなしでCSSの文字列を
 * 検査することで再発を防ぐ。
 */

const RENDERER_SRC = join(process.cwd(), 'src/renderer/src');
const STYLES_CSS = readFileSync(join(RENDERER_SRC, 'styles.css'), 'utf8');
// コメントを剥がしてから解析する(コメント中の '{'/'}' は無いが、コメント文自体が
// 直後のセレクタ文字列に連結されて startsWith 判定を壊すため)
const STYLES_CSS_NO_COMMENTS = STYLES_CSS.replace(/\/\*[\s\S]*?\*\//g, '');

function listTsxFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) listTsxFiles(p, out);
    else if (entry.name.endsWith('.tsx')) out.push(p);
  }
  return out;
}

/** CSSを雑に「セレクタ群 { 宣言 }」のブロック列へ分解する(@keyframesの入れ子は個別ステップが
 *  無関係な擬似ブロックとして混ざるが、実在しないセレクタ名なので後段のクエリには影響しない) */
function parseCssBlocks(css: string): { selectors: string[]; decl: string }[] {
  const blocks: { selectors: string[]; decl: string }[] = [];
  const blockRe = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(css))) {
    const selectors = (m[1] ?? '').trim().split(',').map((s) => s.trim());
    blocks.push({ selectors, decl: (m[2] ?? '').trim() });
  }
  return blocks;
}

/** ライトテーマ内で class(例 " .bg-amber-700")を宣言しているすべてのブロックの
 *  declaration を連結して返す */
function lightDeclarationsFor(blocks: { selectors: string[]; decl: string }[], selectorSuffix: string): string {
  return blocks
    .filter((b) => b.selectors.some((s) => s.startsWith("[data-theme='light']") && s.endsWith(selectorSuffix)))
    .map((b) => b.decl)
    .join(' ');
}

/** クラス名(例 "hover:bg-zinc-800")がライトテーマ側のどれかのセレクタに
 *  現れているか(=上書きルールを持つか)を判定する */
function hasLightOverrideFor(blocks: { selectors: string[]; decl: string }[], cls: string): boolean {
  const escaped = `.${cls.replace(':', '\\:')}`;
  const needle = cls.startsWith('hover:') ? `${escaped}:hover` : escaped;
  return blocks.some((b) => b.selectors.some((s) => s.startsWith("[data-theme='light']") && s.includes(needle)));
}

describe('M25-6: ライトテーマのボタンホバーが黒くならない(回帰)', () => {
  const blocks = parseCssBlocks(STYLES_CSS_NO_COMMENTS);

  it('コンポーネントで実際に使われている暗色系 hover:bg-* クラスは、全てstyles.cssにlight上書きを持つ', () => {
    // ダーク前提で「濃灰〜黒」に見えるTailwindのhover背景クラス。実際にこのバグを起こした
    // zinc/neutral/slate/gray/stone系(700〜950)と、実使用が確認された red-900/950・amber-950。
    const DARK_HOVER_RE =
      /hover:bg-(?:zinc|neutral|slate|gray|stone)-(?:600|700|800|900|950)|hover:bg-(?:red|amber)-(?:900|950)|hover:bg-black/g;

    const files = listTsxFiles(RENDERER_SRC);
    const used = new Set<string>();
    for (const f of files) {
      const content = readFileSync(f, 'utf8');
      for (const m of content.match(DARK_HOVER_RE) ?? []) used.add(m);
    }
    // 前提チェック: 何も見つからなければテスト自体が形骸化しているので気づけるようにする
    expect(used.size).toBeGreaterThan(0);

    const missing = [...used].filter((cls) => !hasLightOverrideFor(blocks, cls));
    expect(missing).toEqual([]);
  });

  it('文字色を明示していない塗りボタン(bg-blue-600/500・bg-red-700・bg-purple-700・bg-amber-700)は、' +
    'styles.cssのlightテーマで明示的に白文字が強制されている', () => {
    // これらはコンポーネント側でtext-*を指定せずTailwind既定の彩度のまま使われている塗りボタン。
    // ダークではボディ既定の明るい文字色を継承して成立していたが、ライトはボディ既定を暗色へ
    // 反転させているため、styles.css側で明示的にcolor:#ffffffを強制していないと
    // 「暗背景+暗文字」で読めなくなる(実際に発見したバグそのもの)。
    const targets = ['bg-blue-600', 'bg-blue-500', 'bg-red-700', 'bg-purple-700', 'bg-amber-700'];
    for (const cls of targets) {
      const decl = lightDeclarationsFor(blocks, ` .${cls}`);
      expect(decl, `[data-theme='light'] .${cls} の宣言が見つからない`).not.toBe('');
      expect(decl, `.${cls} に明示的な白文字(color:#ffffff / #fff)が無い`).toMatch(/color:\s*#fff(?:fff)?\s*;/);
    }
  });

  it('bg-red-700 はバッジの淡ピンク上書き(bg-red-900/950と共有)には含まれない' +
    '(含めると昇格ダイアログの承認ボタン等が淡ピンクに化ける実バグだった)', () => {
    // bg-red-900/bg-red-950 と全く同じ宣言ブロック(=同じセレクタ群)に bg-red-700 が
    // 並んでいないことを確認する(淡ピンク背景色の宣言を bg-red-700 と共有していない)
    const sharedWithRed700 = blocks.some(
      (b) =>
        b.selectors.some((s) => s.endsWith(' .bg-red-900')) && b.selectors.some((s) => s.endsWith(' .bg-red-700')),
    );
    expect(sharedWithRed700).toBe(false);
    // bg-red-700 自身は(白文字強制の別ルールとして)どこかに存在しているはず
    expect(lightDeclarationsFor(blocks, ' .bg-red-700')).not.toBe('');
  });
});
