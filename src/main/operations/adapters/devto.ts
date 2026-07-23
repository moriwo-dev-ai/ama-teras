import type { AdapterRuntime } from '../protocol';

/**
 * M99-16: dev.to(Forem)アダプタ。英語圏へのpull型発信チャネル。
 * 成長戦略上の位置づけ: HNは新規アカウントの投稿が自動killされ、Xはフォロワー0だと
 * 誰にも届かない。dev.toは新規アカウントでも即公開でき、プラットフォームが読者を
 * 連れてくる=フォロワー0の今、英語圏で唯一すぐ効く出口。
 *
 * 掟は他の実行系と同一: 投稿(article)は岩戸ゲートの全文承認を通ったときだけ。
 * APIキーが無ければ capabilities.execute を空にする(宣言と実挙動の一致)。
 */

export type DevtoFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const API = 'https://dev.to/api';

export class DevtoWriter {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: DevtoFetch = (url, init) => fetch(url, init),
  ) {}

  /**
   * 記事を投稿する。published=false なら下書きとして送られ、dev.to上で人間が公開できる。
   * 戻り値は結果メッセージ(URL入り)
   */
  async publishArticle(input: {
    title: string;
    bodyMarkdown: string;
    tags?: string[];
    published: boolean;
    canonicalUrl?: string;
  }): Promise<string> {
    const res = await this.fetchImpl(`${API}/articles`, {
      method: 'POST',
      headers: { 'api-key': this.apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        article: {
          title: input.title,
          body_markdown: input.bodyMarkdown,
          published: input.published,
          // dev.toのタグは最大4つ・英数字のみ
          tags: (input.tags ?? []).slice(0, 4),
          ...(input.canonicalUrl !== undefined ? { canonical_url: input.canonicalUrl } : {}),
        },
      }),
    });
    if (!res.ok) {
      const detail = await res
        .json()
        .then((j) => String((j as Record<string, unknown>)['error'] ?? ''))
        .catch(() => '');
      throw new Error(`dev.to投稿失敗(HTTP ${res.status})${detail !== '' ? `: ${detail}` : ''}`);
    }
    const data = (await res.json()) as Record<string, unknown>;
    const url = String(data['url'] ?? '');
    return input.published ? `公開した: ${url}` : `下書きとして送った(公開はdev.to上で): ${url}`;
  }
}

export function createDevtoAdapter(apiKey: string | null, fetchImpl?: DevtoFetch): AdapterRuntime {
  const writer = apiKey === null || apiKey.trim() === '' ? null : new DevtoWriter(apiKey, fetchImpl);
  return {
    id: 'devto',
    capabilities: {
      read: false,
      search: false,
      draft: true,
      execute: writer === null ? [] : ['article'],
    },
    compliance:
      'dev.to(Forem)公式APIの正規利用(APIキー認証)。記事投稿は岩戸ゲートの全文承認後のみ。' +
      'published:false なら下書き送信(公開はdev.to上で人間が行う)',
    ...(writer !== null
      ? {
          executor: async (action, params) => {
            if (action !== 'article') throw new Error(`未対応のアクション: ${action}`);
            return writer.publishArticle({
              title: String(params['title'] ?? ''),
              bodyMarkdown: String(params['bodyMarkdown'] ?? ''),
              tags: Array.isArray(params['tags']) ? (params['tags'] as string[]) : [],
              published: params['published'] === true,
              ...(typeof params['canonicalUrl'] === 'string' ? { canonicalUrl: params['canonicalUrl'] } : {}),
            });
          },
        }
      : {}),
  };
}
