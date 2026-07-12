import type { AdapterRuntime } from '../protocol';

/**
 * M32-2: xアダプタ(セミオート)。
 * - search: 検索クエリ・検索URLの生成のみ(人間がブラウザで開く)
 * - read: ユーザーが貼り付けたプロフィール/投稿テキストの解析(AMENO-uzume側でLLM評価)
 * - execute: 空配列 = すべて人間が実行(自動フォロー・自動投稿は規約違反+凍結リスク)
 */

export interface XSearchSuggestion {
  label: string;
  query: string;
  url: string;
}

function searchUrl(query: string): string {
  return `https://x.com/search?q=${encodeURIComponent(query)}&f=live`;
}

/** 仲間発見・言及観測のための検索URL群を生成(開くのは人間) */
export function buildXSearchSuggestions(keywords: string[], projectName?: string): XSearchSuggestion[] {
  const suggestions: XSearchSuggestion[] = [];
  for (const kw of keywords) {
    const trimmed = kw.trim();
    if (trimmed === '') continue;
    suggestions.push({
      label: `「${trimmed}」の最新投稿`,
      query: trimmed,
      url: searchUrl(trimmed),
    });
    suggestions.push({
      label: `「${trimmed}」の日本語投稿(リンク付き=作品公開の可能性)`,
      query: `${trimmed} lang:ja filter:links`,
      url: searchUrl(`${trimmed} lang:ja filter:links`),
    });
  }
  // M41-3: プロジェクト名は設定から(未設定なら言及検索は出さない=他人のプロジェクト名を検索しない)
  const name = projectName?.trim() ?? '';
  if (name !== '') {
    const query = `"${name}" OR "${name.toLowerCase()}"`;
    suggestions.push({ label: `${name} への言及`, query, url: searchUrl(query) });
  }
  return suggestions;
}

export function createXAdapter(): AdapterRuntime {
  return {
    id: 'x',
    capabilities: { read: true, search: true, draft: true, execute: [] },
    compliance:
      '自動フォロー・自動投稿・自動いいねはX規約違反(新規アカは凍結リスク大)。検索URL生成と貼り付け解析のみ。実行はすべて人間',
  };
}
