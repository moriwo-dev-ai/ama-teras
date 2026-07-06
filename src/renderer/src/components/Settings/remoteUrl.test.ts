import { describe, expect, it } from 'vitest';
import { buildRemoteUrl, qrGuidance } from './remoteUrl';

describe('buildRemoteUrl(M13-0)', () => {
  it('トークン込みはフラグメント #t= に載る(クエリやパスではない)', () => {
    expect(buildRemoteUrl('mypc.tail1234.ts.net', 8787, 'abc123')).toBe(
      'http://mypc.tail1234.ts.net:8787/#t=abc123',
    );
  });

  it('トークン無しはホスト:ポートのみ', () => {
    expect(buildRemoteUrl('mypc.tail1234.ts.net', 8787)).toBe('http://mypc.tail1234.ts.net:8787/');
    expect(buildRemoteUrl('mypc.tail1234.ts.net', 8787, null)).toBe(
      'http://mypc.tail1234.ts.net:8787/',
    );
  });

  it('ホスト未入力(空白のみ含む)は空文字', () => {
    expect(buildRemoteUrl('', 8787, 'abc')).toBe('');
    expect(buildRemoteUrl('   ', 8787)).toBe('');
  });

  it('ホストの前後空白はトリムされる', () => {
    expect(buildRemoteUrl('  100.64.0.1  ', 9000, 't')).toBe('http://100.64.0.1:9000/#t=t');
  });
});

describe('qrGuidance(M21-3: QR表示分岐の回帰テスト)', () => {
  it('平文トークンあり(有効化/再生成直後)= トークン込みQRの案内・再生成ボタンなし', () => {
    const g = qrGuidance(true, true);
    expect(g.withToken).toBe(true);
    expect(g.offerRegenerate).toBe(false);
    expect(g.message).toContain('トークン込み');
  });

  it('トークン発行済みだが平文なし(再起動後)= トークン無しQR+再生成ボタンを出す', () => {
    const g = qrGuidance(true, false);
    expect(g.withToken).toBe(false);
    expect(g.offerRegenerate).toBe(true);
    expect(g.message).toContain('トークン込みQRを出す');
    expect(g.message).toContain('再設定');
  });

  it('トークン未発行 = 有効化の案内・再生成ボタンなし', () => {
    const g = qrGuidance(false, false);
    expect(g.withToken).toBe(false);
    expect(g.offerRegenerate).toBe(false);
    expect(g.message).toContain('未発行');
  });
});
