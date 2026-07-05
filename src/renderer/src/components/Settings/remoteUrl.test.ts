import { describe, expect, it } from 'vitest';
import { buildRemoteUrl } from './remoteUrl';

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
