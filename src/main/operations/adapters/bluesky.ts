import type { AdapterRuntime } from '../protocol';
import type { FetchLike } from './zenn';

/**
 * M32-2: blueskyアダプタ(骨組み)。公開AppView APIの read/search のみ。
 * 設計上はAT Protocolの自動化に寛容で承認後の投稿・フォローも許容範囲だが、
 * 認証(アプリパスワード保管)未実装のため execute は空 = 提案のみ。
 * 【M32判断】宣言と実挙動の一致を守るため「executeを宣言して未実装エラー」ではなく
 * 「宣言自体を空」にした。投稿対応時に capabilities と executor を同時に足すこと。
 */

export interface BlueskyPost {
  author: string;
  handle: string;
  text: string;
  uri: string;
}

export class BlueskyReader {
  constructor(private readonly fetchImpl: FetchLike = (url) => fetch(url)) {}

  /** 公開検索API(認証不要)。不達は空配列 */
  async searchPosts(query: string, limit = 10): Promise<BlueskyPost[]> {
    try {
      const url = `https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=${encodeURIComponent(query)}&limit=${limit}`;
      const res = await this.fetchImpl(url);
      if (!res.ok) return [];
      const data = (await res.json()) as Record<string, unknown>;
      const posts = data['posts'];
      if (!Array.isArray(posts)) return [];
      return posts.map((p) => {
        const rec = p as Record<string, unknown>;
        const author = (rec['author'] ?? {}) as Record<string, unknown>;
        const record = (rec['record'] ?? {}) as Record<string, unknown>;
        return {
          author: String(author['displayName'] ?? ''),
          handle: String(author['handle'] ?? ''),
          text: String(record['text'] ?? ''),
          uri: String(rec['uri'] ?? ''),
        };
      });
    } catch {
      return [];
    }
  }
}

export function createBlueskyAdapter(): AdapterRuntime {
  return {
    id: 'bluesky',
    capabilities: { read: true, search: true, draft: true, execute: [] },
    compliance:
      'AT Protocolは自動化に寛容(Bot開示が礼儀)。現状は公開APIの読み取りのみ。投稿・フォロー対応時は承認ゲート+自動化開示を実装すること',
  };
}
