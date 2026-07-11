import { describe, expect, it } from 'vitest';
import { buildRemoteUrl, qrGuidance, resolveInitialHost } from './remoteUrl';

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

describe('resolveInitialHost(M32-8: QR消失バグの回帰テスト)', () => {
  const storage = (data: Record<string, string>) => (key: string) => data[key] ?? null;

  it('configにホストがあればそれを使い、自己修復は不要', () => {
    const r = resolveInitialHost('mypc.tail1234.ts.net', storage({ 'amateras-remote-host': 'other' }));
    expect(r).toEqual({ host: 'mypc.tail1234.ts.net', heal: false });
  });

  it('config空でも新キー(amateras-remote-host)から復元し、自己修復を要求する', () => {
    // M27-3のリネーム後、旧キーのみ参照していたためホストが空に戻っていた(バグ本体)
    const r = resolveInitialHost(null, storage({ 'amateras-remote-host': 'mypc.tail1234.ts.net' }));
    expect(r).toEqual({ host: 'mypc.tail1234.ts.net', heal: true });
  });

  it('新キーが無ければ旧キー(mycodex-remote-host)へフォールバックする', () => {
    const r = resolveInitialHost(undefined, storage({ 'mycodex-remote-host': 'oldpc.ts.net' }));
    expect(r).toEqual({ host: 'oldpc.ts.net', heal: true });
  });

  it('新旧両方あれば新キーを優先する', () => {
    const r = resolveInitialHost(
      '',
      storage({ 'amateras-remote-host': 'new.ts.net', 'mycodex-remote-host': 'old.ts.net' }),
    );
    expect(r).toEqual({ host: 'new.ts.net', heal: true });
  });

  it('どこにも無ければ空+自己修復なし(UIは入力案内を表示する)', () => {
    expect(resolveInitialHost(null, storage({}))).toEqual({ host: '', heal: false });
    expect(resolveInitialHost('  ', storage({ 'amateras-remote-host': '   ' }))).toEqual({
      host: '',
      heal: false,
    });
  });
});
