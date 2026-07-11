/**
 * M32-9: 発信ドラフトの「1タップ投稿リンク」(AMENO-uzume追補)。
 * リンクを開いた先で最後のクリックをするのは人間 — 自動投稿は引き続き実装しない
 * (岩戸の掟: Xへの自動投稿は規約違反。Web Intentは公式のセミオート導線)。
 */

/** X Web Intent(投稿画面を本文プリセットで開く。投稿ボタンは人間が押す) */
export function xIntentUrl(text: string): string {
  return `https://x.com/intent/post?text=${encodeURIComponent(text)}`;
}

/** はてなブックマーク追加パネル(URLをブクマする画面。追加ボタンは人間が押す) */
export function hatenaPanelUrl(url: string): string {
  return `https://b.hatena.ne.jp/entry/panel/?url=${encodeURIComponent(url)}`;
}

/** 本文から最初の http(s) URL を取り出す(はてブ対象の記事URL検出用)。無ければ null */
export function firstUrl(text: string): string | null {
  const m = /https?:\/\/[^\s<>"')\]}、。]+/.exec(text);
  return m ? m[0] : null;
}
