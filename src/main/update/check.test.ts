import { describe, expect, it, vi } from 'vitest';
import { checkForUpdate, isNewerVersion, parseVersion } from './check';

const release = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  tag_name: 'v1.2.0',
  name: 'AMA-teras 1.2.0',
  html_url: 'https://github.com/moriwo-dev-ai/ama-teras/releases/tag/v1.2.0',
  draft: false,
  prerelease: false,
  ...over,
});

const okFetch = (body: unknown): typeof fetch =>
  vi.fn(async () => ({ ok: true, json: async () => body })) as unknown as typeof fetch;

describe('M42-1: 更新確認(通知のみ。自動更新はしない)', () => {
  it('版の比較: メジャー・マイナー・パッチを数値で比べる。解釈できない版は通知しない', () => {
    expect(parseVersion('v1.2.3')).toEqual([1, 2, 3]);
    expect(parseVersion('1.2.3')).toEqual([1, 2, 3]);
    expect(parseVersion('v1.2.3-beta')).toBeNull();
    expect(isNewerVersion('v1.10.0', 'v1.9.0')).toBe(true); // 文字列比較なら誤る境界
    expect(isNewerVersion('v2.0.0', 'v1.9.9')).toBe(true);
    expect(isNewerVersion('v1.0.0', 'v1.0.0')).toBe(false);
    expect(isNewerVersion('v0.9.0', 'v1.0.0')).toBe(false);
    expect(isNewerVersion('nightly', 'v1.0.0')).toBe(false);
  });

  it('新しい版があれば newer:true(URLとタグを返す)', async () => {
    const info = await checkForUpdate('1.0.0', 'https://api.example/latest', okFetch(release()));
    expect(info).toMatchObject({ current: '1.0.0', latest: 'v1.2.0', newer: true });
    expect(info?.url).toContain('releases/tag/v1.2.0');
  });

  it('同じ版・古い版では newer:false(バナーを出さない)', async () => {
    const info = await checkForUpdate('1.2.0', 'https://api.example/latest', okFetch(release()));
    expect(info?.newer).toBe(false);
  });

  it('ドラフト・プレリリースは通知しない(公開された安定版だけを勧める)', async () => {
    expect(await checkForUpdate('1.0.0', 'https://api.example/latest', okFetch(release({ prerelease: true })))).toBeNull();
    expect(await checkForUpdate('1.0.0', 'https://api.example/latest', okFetch(release({ draft: true })))).toBeNull();
  });

  it('URLが https でなければ空にする(外部から来たURLをそのまま開かない)', async () => {
    const info = await checkForUpdate(
      '1.0.0',
      'https://api.example/latest',
      okFetch(release({ html_url: 'javascript:alert(1)' })),
    );
    expect(info?.url).toBe('');
  });

  it('空文字URL=無効。不達・HTTPエラー・不正JSONはすべて null(静かに何も出さない)', async () => {
    const spy = vi.fn();
    expect(await checkForUpdate('1.0.0', '', spy as unknown as typeof fetch)).toBeNull();
    expect(spy).not.toHaveBeenCalled(); // 無効なら通信もしない

    const failing = vi.fn(async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch;
    expect(await checkForUpdate('1.0.0', 'https://api.example/latest', failing)).toBeNull();

    const throwing = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await checkForUpdate('1.0.0', 'https://api.example/latest', throwing)).toBeNull();

    expect(await checkForUpdate('1.0.0', 'https://api.example/latest', okFetch({ tag_name: '' }))).toBeNull();
  });
});
