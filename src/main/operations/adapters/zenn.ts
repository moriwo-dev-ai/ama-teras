import type { ZennMetrics } from '../../../shared/types';
import type { AdapterRuntime } from '../protocol';

/**
 * M32-2: zennアダプタ。公開JSON API(zenn.dev/api/articles/{slug})の読み取りのみ。
 * execute は無い(提案のみの媒体)。
 */

/** 注入可能なfetch。M35-4: 書き込み系(Bluesky)のためinit(POST)も受けられる形に拡張
 *  (読み取り専用の実装・モックはinitを無視してよい=後方互換) */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export class ZennReader {
  constructor(private readonly fetchImpl: FetchLike = (url) => fetch(url)) {}

  async articleMetrics(slug: string): Promise<ZennMetrics | null> {
    try {
      const res = await this.fetchImpl(`https://zenn.dev/api/articles/${encodeURIComponent(slug)}`);
      if (!res.ok) return null;
      const data = (await res.json()) as Record<string, unknown>;
      const article = (data['article'] ?? data) as Record<string, unknown>;
      const liked = article['liked_count'];
      const comments = article['comments_count'];
      const path = article['path']; // M34-1: 正規URL(はてブ数の自動導出用)
      return {
        liked: typeof liked === 'number' ? liked : 0,
        comments: typeof comments === 'number' ? comments : 0,
        ...(typeof path === 'string' && path.startsWith('/') ? { path } : {}),
      };
    } catch {
      return null;
    }
  }
}

export function createZennAdapter(): AdapterRuntime {
  return {
    id: 'zenn',
    capabilities: { read: true, search: false, draft: true, execute: [] },
    compliance: '公開JSON APIの読み取りのみ。投稿・いいねの自動化はしない(提案のみ)',
  };
}
