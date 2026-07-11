import type { OperationsDraft } from '../../../../shared/types';

/**
 * M37: 下書きの種類 → 行き先の対応(コードで固定)。
 *
 * Xの文字数制限に合わない種類(リリースノート・記事・週報)にXボタンを出さない、
 * というのがこの表の主目的。行き先ごとの発行は必ず岩戸ゲート(承認)を通り、
 * X だけは規約上「投稿画面を開くまで」(最後のクリックは人間)。
 */
export type DraftAction =
  /** X Web Intent(投稿画面を開く。投稿ボタンは人間) */
  | 'x-intent'
  /** はてブ追加パネル(本文中にURLがある場合のみ) */
  | 'hatena'
  /** GitHub Release(下書き)へ — 岩戸ゲート経由 */
  | 'github-release'
  /** Zenn記事化(本文をLLMで起こし、published:false でコミット)— 岩戸ゲート経由 */
  | 'zenn-article';

const ACTIONS: Record<OperationsDraft['kind'], DraftAction[]> = {
  // 短文=Xの投稿画面へ。本文にURLがあればはてブも
  'x-post': ['x-intent', 'hatena'],
  // 返信も短文だが、行き先(GitHub/HN/Bluesky等)は文脈依存なのでコピーのみ
  reply: [],
  // Markdown長文=Xに載らない。行き先はGitHub Release
  'release-note': ['github-release'],
  // 行き先はZenn(本文化 → published:false でコミット)
  'article-outline': ['zenn-article'],
  // 本文化済みの記事は再度LLMを通さない(コピーのみ。コミットはアウトライン側から)
  'article-body': [],
  // 週報は自分用の記録。外部への行き先を持たない
  'weekly-report': [],
};

/** 種類ごとのアクション(コピーはどの種類にも常に出るので含めない) */
export function draftActionsFor(kind: OperationsDraft['kind']): DraftAction[] {
  return ACTIONS[kind] ?? [];
}
