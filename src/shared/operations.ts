/**
 * M39: 運営の一括承認まわりの共有定数(main と renderer が同じ判断をするため)。
 * ロジックは置かない(判定の純関数のみ)。
 */

/**
 * リンクを開くところまでしかできない媒体(アプリからは何も発行しない)。
 * X は規約上、自動投稿・自動フォローを実装しない(アダプタの execute 宣言も空)。
 * はてブも同様に「追加画面を開く」まで。最後のクリックは必ず人間が押す。
 */
export const LINK_ONLY_ADAPTERS = ['x', 'hatena'] as const;

export function isLinkOnlyAdapter(adapterId: string): boolean {
  return (LINK_ONLY_ADAPTERS as readonly string[]).includes(adapterId);
}

/** 一度に開くブラウザウィンドウの上限。超えた分は「続きを開く」で人間が刻む */
export const MAX_LINKS_PER_OPEN = 5;

/** X Web Intent(投稿画面を本文プリセットで開く。投稿ボタンは人間が押す) */
export function xIntentUrl(text: string): string {
  return `https://x.com/intent/post?text=${encodeURIComponent(text)}`;
}

/** はてなブックマーク追加パネル(追加ボタンは人間が押す) */
export function hatenaPanelUrl(url: string): string {
  return `https://b.hatena.ne.jp/entry/panel/?url=${encodeURIComponent(url)}`;
}

/**
 * M43-1: 発信テキストのプレースホルダ解決。
 * AMENO-uzume のプロンプトは「リンクは {URL} と書け」と指示するが、**置換する処理が
 * どこにも無かった**ため、X・Blueskyへ `{URL}` の文字列がそのまま投稿されていた(実害)。
 * URLが未設定なら、置換ではなく**プレースホルダごと落とす**(意味のない文字列を出さない)
 */
export function resolvePostText(body: string, projectUrl: string): string {
  const replaced =
    projectUrl === '' ? body.replace(/\s*\{URL\}\s*/g, ' ') : body.replace(/\{URL\}/g, projectUrl);
  return replaced.replace(/[ \t]{2,}/g, ' ').trim();
}

/**
 * M43-1: 未解決のプレースホルダ(`{URL}` `{TAG}` 等)が残っていないか。
 * 発信の直前にこれを見て、残っていたら**実行しない**(テンプレートを外に出さないための最後の砦)
 */
export function hasUnresolvedPlaceholder(text: string): boolean {
  return /\{[A-Z][A-Z_]{1,}\}/.test(text);
}

/** リポジトリ名(owner/repo)→ GitHubのURL。{URL} の既定の解決先 */
export function repoUrl(repo: string | undefined): string {
  return repo === undefined || repo.trim() === '' ? '' : `https://github.com/${repo.trim()}`;
}

/** 本文から最初の http(s) URL(はてブ対象の記事URL検出)。無ければ null */
export function firstUrl(text: string): string | null {
  const m = /https?:\/\/[^\s<>"')\]}、。]+/.exec(text);
  return m ? m[0] : null;
}

/**
 * アダプタid → 媒体名(下書きの media 欄・効果測定・戦略ボードで使う共通の呼び名)。
 * 'zenn-repo' は実装の都合の名前なので、媒体としては 'zenn' に寄せる
 */
export function mediaOf(adapterId: string): string {
  return adapterId === 'zenn-repo' ? 'zenn' : adapterId;
}

/**
 * M44: この行き先へ出したら、下書きを「投稿済み」にしてよいか。
 * X は規約上リンクを開くまでしかできない(最後のPostは人間)が、**開いた時点で投稿済みにする**
 * — でないと下書きが残り続けて二重送信の元になる(UIから「未投稿に戻す」で取り消せる)。
 * はてブは同じ下書きの補助(ブックマーク)なので投稿済みにしない
 * (してしまうと、その下書きのX投稿が「済み」扱いで消える)
 */
export function marksDraftPosted(adapterId: string): boolean {
  return adapterId !== 'hatena';
}

/** 一括承認の単位キー(媒体×アクション)。異なる媒体・アクションは混ぜない */
export function bulkGroupKey(adapterId: string, actionName: string): string {
  return `${adapterId}:${actionName}`;
}

/** 一括実行の結果(1件ずつの成否。途中で失敗しても残りは続行する) */
export interface BulkItemResult {
  itemId: string;
  target: string;
  ok: boolean;
  detail: string;
}

export interface BulkRespondResult {
  ok: boolean;
  /** 例: 「3件中2件成功」 */
  detail: string;
  results: BulkItemResult[];
  /** リンク媒体(X/はてブ)のとき、renderer が開くURL。main は何も発行しない */
  links?: { itemId: string; label: string; url: string }[];
}
