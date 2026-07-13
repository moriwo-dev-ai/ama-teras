import { describe, expect, it, vi } from 'vitest';
import { formatPublishState } from './kamuhakari';
import { ZennReader } from './adapters/zenn';

/**
 * M76: **出したつもりと、出ていることは別**。
 *
 * 実害: 3本を published: true にして push したが、Zenn が同期したのは2本だけ。
 * 残り1本は Zenn 上で 403(存在するが非公開)のまま、つまり**誰も読めない**。
 * それなのにアプリの台帳は「投稿済み」と記録し、逆に**実際に公開された2本は
 * 「公開待ち」のまま残った**。台帳がこちらの申告を書いているだけで、
 * 世界の実際の状態を見ていなかった(M57/M64と同じ病気)。
 */

const res = (status: number): Response => ({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve({}) }) as Response;

describe('M76: Zennで実際に読めるかを聞く', () => {
  it('200=読める / 403(存在するが非公開)=読めない / 404=読めない', async () => {
    const reader = (status: number) => new ZennReader(() => Promise.resolve(res(status)));

    expect(await reader(200).isLive('s')).toBe(true);
    expect(await reader(403).isLive('s')).toBe(false); // 実機で起きたやつ
    expect(await reader(404).isLive('s')).toBe(false);
  });

  it('ネットワーク不達は「公開されていない」ではなく「不明」(嘘をつかない)', async () => {
    const reader = new ZennReader(() => Promise.reject(new Error('offline')));
    expect(await reader.isLive('s')).toBeUndefined();
  });
});

describe('M76: 神議には「push した」ではなく「読めるか」を渡す', () => {
  it('published: true でも Zennで読めないものは、露出ゼロとして書く', () => {
    const text = formatPublishState({
      releases: [],
      zennArticles: [
        { slug: 'live-one', published: true, live: true },
        { slug: 'pushed-but-dark', published: true, live: false }, // 実機で起きたやつ
        { slug: 'not-yet', published: false },
      ],
      unavailable: [],
    });

    expect(text).toContain('live-one: 公開済み(Zennで実際に読める)');
    expect(text).toContain('pushed-but-dark: **published: true にしたが、Zennではまだ読めない');
    expect(text).toContain('露出ゼロ');
    expect(text).toContain('not-yet: **published: false');
  });

  it('Zenn側を確認できていないときは、確認できていないと書く(公開済みと断定しない)', () => {
    const text = formatPublishState({
      releases: [],
      zennArticles: [{ slug: 'unknown', published: true }],
      unavailable: [],
    });
    expect(text).toContain('Zenn側は未確認');
  });
});

describe('M76: 実機の再現(fetchの呼び先を固定)', () => {
  it('isLive は Zenn の公開APIを叩く', async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn((url: string) => {
      urls.push(url);
      return Promise.resolve(res(200));
    });
    await new ZennReader(fetchImpl).isLive('my-article-001');
    expect(urls[0]).toBe('https://zenn.dev/api/articles/my-article-001');
  });
});
