import { describe, expect, it } from 'vitest';
import { generateToken, hashToken, RemoteAuth } from './auth';

describe('generateToken / hashToken', () => {
  it('トークンは hex 64文字、ハッシュは sha256 hex 64文字で、毎回異なる', () => {
    const a = generateToken();
    const b = generateToken();
    expect(a.token).toMatch(/^[0-9a-f]{64}$/);
    expect(a.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.token).not.toBe(b.token);
    expect(hashToken(a.token)).toBe(a.tokenHash);
    // 平文とハッシュは一致しない(平文がそのまま保存されない)
    expect(a.tokenHash).not.toBe(a.token);
  });
});

describe('RemoteAuth.verify', () => {
  it('正しいトークンは ok、誤りは unauthorized', () => {
    const { token, tokenHash } = generateToken();
    const auth = new RemoteAuth({ getTokenHash: () => tokenHash });
    expect(auth.verify(token, '100.1.2.3')).toBe('ok');
    expect(auth.verify('bad-token', '100.1.2.3')).toBe('unauthorized');
    expect(auth.verify(undefined, '100.1.2.3')).toBe('unauthorized');
  });

  it('トークン未発行(hash無し)なら正しそうな値でも全拒否', () => {
    const auth = new RemoteAuth({ getTokenHash: () => undefined });
    expect(auth.verify(generateToken().token, '100.1.2.3')).toBe('unauthorized');
  });

  it('連続失敗でバンされ、正しいトークンでも banned になる', () => {
    const { token, tokenHash } = generateToken();
    let now = 1_000_000;
    const auth = new RemoteAuth({ getTokenHash: () => tokenHash, maxFailures: 3, banMs: 60_000, now: () => now });
    expect(auth.verify('x', 'ip-a')).toBe('unauthorized');
    expect(auth.verify('x', 'ip-a')).toBe('unauthorized');
    expect(auth.verify('x', 'ip-a')).toBe('unauthorized'); // 3回目でバン発動
    expect(auth.verify(token, 'ip-a')).toBe('banned');
    // 別IPは影響を受けない
    expect(auth.verify(token, 'ip-b')).toBe('ok');
    // バン時間経過後は正しいトークンで復帰できる
    now += 60_001;
    expect(auth.verify(token, 'ip-a')).toBe('ok');
  });

  it('成功すると失敗カウントがリセットされる', () => {
    const { token, tokenHash } = generateToken();
    const auth = new RemoteAuth({ getTokenHash: () => tokenHash, maxFailures: 3 });
    auth.verify('x', 'ip-a');
    auth.verify('x', 'ip-a');
    expect(auth.verify(token, 'ip-a')).toBe('ok');
    // リセット済みなので、また3回失敗するまでバンされない
    expect(auth.verify('x', 'ip-a')).toBe('unauthorized');
    expect(auth.verify('x', 'ip-a')).toBe('unauthorized');
    expect(auth.verify(token, 'ip-a')).toBe('ok');
  });

  it('トークン再生成(hash差し替え)で旧トークンは即失効する', () => {
    const first = generateToken();
    let currentHash = first.tokenHash;
    const auth = new RemoteAuth({ getTokenHash: () => currentHash });
    expect(auth.verify(first.token, 'ip-a')).toBe('ok');
    const second = generateToken();
    currentHash = second.tokenHash;
    expect(auth.verify(first.token, 'ip-a')).toBe('unauthorized');
    expect(auth.verify(second.token, 'ip-a')).toBe('ok');
  });

  it('長さの違うhashでも例外を出さず拒否する(壊れたconfig対策)', () => {
    const auth = new RemoteAuth({ getTokenHash: () => 'abcd' });
    expect(auth.verify('whatever', 'ip-a')).toBe('unauthorized');
  });
});
