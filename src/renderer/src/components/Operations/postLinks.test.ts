import { describe, expect, it } from 'vitest';
import { firstUrl, hatenaPanelUrl, xIntentUrl } from './postLinks';

describe('M32-9: 1タップ投稿リンク', () => {
  it('X Web Intent: 本文がURLエンコードされて text= に載る', () => {
    const url = xIntentUrl('AMA-teras公開!🛡 #個人開発\nhttps://example.com');
    expect(url.startsWith('https://x.com/intent/post?text=')).toBe(true);
    expect(url).toContain(encodeURIComponent('#個人開発'));
    expect(url).toContain(encodeURIComponent('https://example.com'));
    // 生の # や改行が残っているとintentが壊れる
    expect(url.slice('https://x.com/intent/post?text='.length)).not.toMatch(/[#\n]/);
  });

  it('はてブ追加パネル: 対象URLがエンコードされて url= に載る', () => {
    expect(hatenaPanelUrl('https://zenn.dev/a/articles/b?x=1')).toBe(
      `https://b.hatena.ne.jp/entry/panel/?url=${encodeURIComponent('https://zenn.dev/a/articles/b?x=1')}`,
    );
  });

  it('firstUrl: 本文中の最初のURLを取り出し、句読点・閉じ括弧は含めない', () => {
    expect(firstUrl('記事はこちら https://zenn.dev/a/articles/b と https://example.com')).toBe(
      'https://zenn.dev/a/articles/b',
    );
    expect(firstUrl('(https://example.com/path)を見て')).toBe('https://example.com/path');
    expect(firstUrl('リンク: https://example.com/x。以上')).toBe('https://example.com/x');
    expect(firstUrl('URLなし {URL} プレースホルダのみ')).toBeNull();
  });
});
