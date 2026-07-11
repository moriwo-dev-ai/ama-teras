import type { AdapterRuntime } from '../protocol';
import type { FetchLike } from './zenn';

/**
 * M34-1: はてなブックマーク アダプタ(read専用)。
 * 公開のブクマ件数API(bookmark.hatenaapis.com)のみ使用。ブクマの追加は人間が行う
 * (追加パネルへの1タップリンクは postLinks.ts / M32-9)。
 */

export class HatenaReader {
  constructor(private readonly fetchImpl: FetchLike = (url) => fetch(url)) {}

  /** 複数URLのブクマ数を一括取得(不達URLは欠落)。APIは url→count のJSONを返す */
  async counts(urls: string[]): Promise<Record<string, number>> {
    const unique = [...new Set(urls.filter((u) => /^https?:\/\//.test(u)))].slice(0, 50);
    if (unique.length === 0) return {};
    try {
      const query = unique.map((u) => `url=${encodeURIComponent(u)}`).join('&');
      const res = await this.fetchImpl(`https://bookmark.hatenaapis.com/count/entries?${query}`);
      if (!res.ok) return {};
      const data = (await res.json()) as Record<string, unknown>;
      const out: Record<string, number> = {};
      for (const [url, count] of Object.entries(data)) {
        if (typeof count === 'number') out[url] = count;
      }
      return out;
    } catch {
      return {};
    }
  }
}

export function createHatenaAdapter(): AdapterRuntime {
  return {
    id: 'hatena',
    capabilities: { read: true, search: false, draft: true, execute: [] },
    compliance: '公開のブクマ件数APIの読み取りのみ。ブクマ追加は人間(1タップリンクあり)',
  };
}
