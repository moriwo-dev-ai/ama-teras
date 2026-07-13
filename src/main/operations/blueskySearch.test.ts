import { describe, expect, it, vi } from 'vitest';
import { BlueskyReader, makeTokenProvider } from './adapters/bluesky';

/**
 * M58: **働いていない神が、働いているように見えていた**。
 *
 * Blueskyは無認証の検索を止めており、公開検索APIは全クエリに403を返すようになった。
 * ところが `searchPosts` は `if (!res.ok) return []` で握りつぶしていたため、
 * 巡回の神(AMENO-uzume)は毎時「巡回完了(評価0/候補0)」と**成功を報告**していた。
 * 仲間候補が一人も見つからないのは「界隈に人がいないから」ではなく、
 * **一度も検索できていなかったから**だった。
 */
const res = (status: number, body: unknown): Response =>
  ({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) }) as Response;

const postsBody = {
  posts: [
    { uri: 'at://1', author: { handle: 'alice.bsky.social', displayName: 'Alice' }, record: { text: '自作エージェントの話' } },
  ],
};

describe('M58: Bluesky検索の失敗を握りつぶさない', () => {
  it('403(認証必須)は空配列ではなく例外。しかも何をすればいいかを言う', async () => {
    const reader = new BlueskyReader(() => Promise.resolve(res(403, {})));

    await expect(reader.searchPosts('AIエージェント')).rejects.toThrow(/認証必須.*app password/s);
  });

  it('トークンがあれば、自分のPDS経由で Authorization を付けて検索する', async () => {
    const fetchImpl = vi.fn((_url: string, _init?: RequestInit) => Promise.resolve(res(200, postsBody)));
    const reader = new BlueskyReader(fetchImpl, () => Promise.resolve('jwt-token'));

    const posts = await reader.searchPosts('AIエージェント');

    expect(posts[0]?.handle).toBe('alice.bsky.social');
    const [url, init] = fetchImpl.mock.calls[0]!;
    // app password のトークンは公開AppViewでは受け付けられない。PDSが代理する
    expect(url).toContain('bsky.social');
    expect((init!.headers as Record<string, string>)['authorization']).toBe('Bearer jwt-token');
  });

  it('資格情報が無ければトークンはnull(=認証なしで叩き、403で失敗する=正しく気付ける)', async () => {
    const token = makeTokenProvider(() => null);

    await expect(token()).resolves.toBeNull();
  });

  it('トークンは15分使い回す(巡回のたびにログインし直さない)', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(res(200, { accessJwt: 'jwt' })));
    let now = 1000;
    const token = makeTokenProvider(
      () => ({ identifier: 'me', appPassword: 'pw' }),
      fetchImpl,
      () => now,
    );

    await token();
    await token();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    now += 16 * 60_000; // 15分より後
    await token();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

/**
 * M72: **テストは全部 fetch を注入していた。本番だけが既定値を使っていた。**
 * その既定値が `(url) => fetch(url)` で、init(=Authorizationヘッダ)を捨てていたため、
 * ログインは成功してトークンも取れているのに、検索リクエストだけ無認証で bsky.social へ飛び 401。
 * それを「app passwordが失効している」と誤診し、ユーザーに再発行を依頼していた(濡れ衣)。
 * 注入なしの経路(=実アプリが通る経路)を固定する。
 */
describe('M72: 注入なし(実アプリの経路)でもヘッダが届く', () => {
  it('既定の fetch は init を捨てない — Authorization が実際に送られる', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(res(200, postsBody));
    }) as typeof fetch;
    try {
      // fetchImpl を渡さない = 実アプリと同じ構成
      const reader = new BlueskyReader(undefined, () => Promise.resolve('jwt-token'));

      await reader.searchPosts('AIエージェント');

      const headers = calls[0]!.init?.headers as Record<string, string> | undefined;
      expect(headers?.['authorization']).toBe('Bearer jwt-token');
      expect(headers?.['atproto-proxy']).toBe('did:web:api.bsky.app#bsky_appview');
    } finally {
      globalThis.fetch = original;
    }
  });
});
