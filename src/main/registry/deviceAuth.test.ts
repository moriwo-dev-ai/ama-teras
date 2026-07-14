import { describe, expect, it } from 'vitest';
import { pollForToken, requestDeviceCode } from './deviceAuth';

/**
 * M91-6: Device Flow。実ネットワークには出さず、GitHub の応答を差し替えて
 * 「保留 → 承認 → 成功」「slow_down で間隔を広げる」「期限切れ・拒否」を確かめる。
 * 本物のブラウザ承認(人間の操作)は最後に実機で一緒に確認する
 */

/** JSONを返すだけの fetch。呼ばれるたびに順番の応答を返す */
function fakeFetch(responses: unknown[]): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  const fetchFn = ((url: string, init?: { body?: string }) => {
    calls.push(String(init?.body ?? ''));
    const body = responses[Math.min(i, responses.length - 1)];
    i++;
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  }) as unknown as typeof fetch;
  return { fetch: fetchFn, calls };
}

const noSleep = (): Promise<void> => Promise.resolve();

describe('requestDeviceCode', () => {
  it('user_code と verification_uri を取り出す', async () => {
    const { fetch } = fakeFetch([
      {
        device_code: 'DC123',
        user_code: 'WDJB-MJHT',
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: 5,
      },
    ]);
    const r = await requestDeviceCode('Iv1.abc', 'public_repo', fetch);
    expect(r.userCode).toBe('WDJB-MJHT');
    expect(r.deviceCode).toBe('DC123');
    expect(r.intervalSec).toBe(5);
  });

  it('Device Flow 無効の OAuth App は、有効化を促して落ちる', async () => {
    const { fetch } = fakeFetch([{ error: 'device_flow_disabled', error_description: 'device flow is not enabled' }]);
    await expect(requestDeviceCode('Iv1.abc', 'public_repo', fetch)).rejects.toThrow(/Enable Device Flow/);
  });

  it('Client ID 不正など、コードが無ければ落ちる', async () => {
    const { fetch } = fakeFetch([{ something: 'else' }]);
    await expect(requestDeviceCode('bad', 'public_repo', fetch)).rejects.toThrow(/デバイスコードが無い/);
  });
});

describe('pollForToken', () => {
  it('保留を挟んでから承認されればトークンを返す', async () => {
    const { fetch, calls } = fakeFetch([
      { error: 'authorization_pending' },
      { error: 'authorization_pending' },
      { access_token: 'gho_realtoken', token_type: 'bearer', scope: 'public_repo' },
    ]);
    const r = await pollForToken('Iv1.abc', 'DC123', {
      intervalSec: 5,
      expiresInSec: 900,
      fetchFn: fetch,
      sleep: noSleep,
      now: () => 0,
    });
    expect(r).toEqual({ ok: true, token: 'gho_realtoken', scope: 'public_repo' });
    // grant_type と device_code を毎回送っている
    expect(calls[0]).toContain('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code');
    expect(calls[0]).toContain('device_code=DC123');
  });

  it('slow_down が来ても諦めず、間隔を広げて続ける', async () => {
    const { fetch } = fakeFetch([
      { error: 'slow_down', interval: 10 },
      { access_token: 'gho_x', scope: 'public_repo' },
    ]);
    const r = await pollForToken('id', 'DC', {
      intervalSec: 5,
      expiresInSec: 900,
      fetchFn: fetch,
      sleep: noSleep,
      now: () => 0,
    });
    expect(r.ok).toBe(true);
  });

  it('拒否されたら、その旨を返す(待ち続けない)', async () => {
    const { fetch } = fakeFetch([{ error: 'access_denied' }]);
    const r = await pollForToken('id', 'DC', {
      intervalSec: 5,
      expiresInSec: 900,
      fetchFn: fetch,
      sleep: noSleep,
      now: () => 0,
    });
    expect(r).toEqual({ ok: false, reason: 'ブラウザで承認が拒否された' });
  });

  it('期限を過ぎたら、待ち続けずに終わる', async () => {
    // now が常に deadline を超えていれば、最初のループで打ち切る
    const { fetch } = fakeFetch([{ error: 'authorization_pending' }]);
    const r = await pollForToken('id', 'DC', {
      intervalSec: 5,
      expiresInSec: 0,
      fetchFn: fetch,
      sleep: noSleep,
      now: () => 1_000_000,
    });
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ reason: expect.stringContaining('有効期限') });
  });

  it('expired_token も期限切れとして返す', async () => {
    const { fetch } = fakeFetch([{ error: 'expired_token' }]);
    let t = 0;
    const r = await pollForToken('id', 'DC', {
      intervalSec: 5,
      expiresInSec: 900,
      fetchFn: fetch,
      sleep: noSleep,
      now: () => (t += 100), // 進むが deadline(900_000)には届かない
    });
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ reason: expect.stringContaining('有効期限') });
  });
});
