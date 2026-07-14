import { describe, expect, it } from 'vitest';
import { causeChain, shortLLMError } from './llmErrors';

/**
 * M88: 別PCに配布版を入れたら「✗ 接続失敗: Connection error.」だけが出た。
 * OpenAI SDK は fetch が落ちると **"Connection error." としか言わない**。本当の原因
 * (名前が引けない / 届かない / TLSで弾かれた)は err.cause の中にいるのに、
 * こちらがそれを握りつぶしていたため、鍵・モデル・回線のどれが悪いのか誰にも分からなかった。
 */

const apiConnectionError = (code: string, msg: string): Error => {
  const inner = Object.assign(new Error(msg), { code });
  return Object.assign(new Error('Connection error.'), { cause: inner });
};

describe('M88: 通信が張れなかった本当の原因を出す', () => {
  it('DNSで引けない(ENOTFOUND)を、Connection error の陰から出す', () => {
    const e = apiConnectionError('ENOTFOUND', 'getaddrinfo ENOTFOUND api.openai.com');

    expect(causeChain(e)).toContain('ENOTFOUND');
    expect(shortLLMError(e)).toContain('Connection error.');
    expect(shortLLMError(e)).toContain('原因');
    expect(shortLLMError(e)).toContain('ENOTFOUND');
  });

  it('TLSで弾かれた場合も原因が出る(セキュリティソフトの傍受・時計ズレ)', () => {
    const e = apiConnectionError('UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'unable to verify the first certificate');
    expect(shortLLMError(e)).toContain('UNABLE_TO_VERIFY_LEAF_SIGNATURE');
  });

  it('cause が無い普通のエラーは、今までどおり短く出す(余計な括弧を足さない)', () => {
    expect(shortLLMError(new Error('401 Unauthorized'))).toBe('401 Unauthorized');
    expect(causeChain(new Error('x'))).toBe('');
  });

  it('cause が入れ子でも辿る(fetch → undici → syscall)', () => {
    const syscall = Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' });
    const undici = Object.assign(new Error('fetch failed'), { cause: syscall });
    const sdk = Object.assign(new Error('Connection error.'), { cause: undici });

    expect(causeChain(sdk)).toContain('fetch failed');
    expect(causeChain(sdk)).toContain('ETIMEDOUT');
  });
});
