import type { AdapterRuntime } from '../protocol';
import type { FetchLike } from './zenn';

/**
 * M33-7: Hacker News アダプタ(read/searchのみ)。
 * - 検索: Algolia HN Search API(公開・認証不要)
 * - スレッド/コメント: 公式 Firebase API(読み取り専用)
 * execute は無い(HNへの投稿・コメントは必ず人間がブラウザで行う)。
 */

export interface HnStory {
  id: number;
  title: string;
  url: string;
  points: number;
  numComments: number;
  author: string;
}

export class HnReader {
  constructor(private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init)) {}

  /** キーワード検索(言及の観測・Show HN後の反応追跡用) */
  async search(query: string, limit = 10): Promise<HnStory[]> {
    try {
      const res = await this.fetchImpl(
        `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&hitsPerPage=${limit}`,
      );
      if (!res.ok) return [];
      const data = (await res.json()) as Record<string, unknown>;
      const hits = data['hits'];
      if (!Array.isArray(hits)) return [];
      return hits.map((h) => {
        const hr = h as Record<string, unknown>;
        const id = Number(hr['objectID'] ?? 0);
        return {
          id,
          title: String(hr['title'] ?? hr['story_title'] ?? ''),
          url: String(hr['url'] ?? `https://news.ycombinator.com/item?id=${id}`),
          points: Number(hr['points'] ?? 0),
          numComments: Number(hr['num_comments'] ?? 0),
          author: String(hr['author'] ?? ''),
        };
      });
    } catch {
      return [];
    }
  }

  /** スレッドのコメント本文(公式API。トップレベルのみ・上限つき) */
  async comments(storyId: number, limit = 10): Promise<{ author: string; text: string }[]> {
    try {
      const res = await this.fetchImpl(`https://hacker-news.firebaseio.com/v0/item/${storyId}.json`);
      if (!res.ok) return [];
      const story = (await res.json()) as Record<string, unknown>;
      const kids = Array.isArray(story['kids']) ? (story['kids'] as number[]).slice(0, limit) : [];
      const out: { author: string; text: string }[] = [];
      for (const kid of kids) {
        const cRes = await this.fetchImpl(`https://hacker-news.firebaseio.com/v0/item/${kid}.json`);
        if (!cRes.ok) continue;
        const c = (await cRes.json()) as Record<string, unknown>;
        if (c['deleted'] === true || c['dead'] === true) continue;
        out.push({
          author: String(c['by'] ?? ''),
          text: String(c['text'] ?? '').replace(/<[^>]+>/g, ' ').slice(0, 1000),
        });
      }
      return out;
    } catch {
      return [];
    }
  }
}

export interface HnCommentNode {
  id: number;
  author: string;
  text: string;
}

/** M34-2: karma監視(公式API・読み取りのみ) */
export async function fetchUserKarma(
  fetchImpl: FetchLike,
  user: string,
): Promise<{ karma: number; submitted: number[] } | null> {
  try {
    const res = await fetchImpl(`https://hacker-news.firebaseio.com/v0/user/${encodeURIComponent(user)}.json`);
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, unknown> | null;
    if (data === null) return null;
    return {
      karma: typeof data['karma'] === 'number' ? data['karma'] : 0,
      submitted: Array.isArray(data['submitted']) ? (data['submitted'] as number[]).slice(0, 30) : [],
    };
  } catch {
    return null;
  }
}

/** M34-2: item取得(スレッドのdescendants数・自コメントのkids=返信の検知に使う) */
export async function fetchItem(
  fetchImpl: FetchLike,
  id: number,
): Promise<{ id: number; by: string; text: string; title: string; kids: number[]; descendants: number; type: string } | null> {
  try {
    const res = await fetchImpl(`https://hacker-news.firebaseio.com/v0/item/${id}.json`);
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, unknown> | null;
    if (data === null || data['deleted'] === true) return null;
    return {
      id,
      by: String(data['by'] ?? ''),
      text: String(data['text'] ?? '').replace(/<[^>]+>/g, ' '),
      title: String(data['title'] ?? ''),
      kids: Array.isArray(data['kids']) ? (data['kids'] as number[]) : [],
      descendants: typeof data['descendants'] === 'number' ? data['descendants'] : 0,
      type: String(data['type'] ?? ''),
    };
  } catch {
    return null;
  }
}

export function createHnAdapter(): AdapterRuntime {
  return {
    id: 'hn',
    capabilities: { read: true, search: true, draft: true, execute: [] },
    compliance: 'Algolia HN Search+公式Firebase APIの読み取りのみ。投稿・コメントは人間がブラウザで',
  };
}
