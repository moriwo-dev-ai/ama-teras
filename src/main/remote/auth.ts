import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * M10-2: リモートアクセスのペアリングトークン認証。
 * - トークンは 32 bytes ランダム(hex 64文字)。平文は保存せず sha256(hex) のみ config へ
 * - 比較は timingSafeEqual(タイミング攻撃対策)
 * - 認証失敗が一定回数続いた接続元IPは一定時間バン(Tailscale内が前提だが念のため)
 */

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function generateToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('hex');
  return { token, tokenHash: hashToken(token) };
}

export type AuthResult = 'ok' | 'unauthorized' | 'banned';

export interface RemoteAuthOptions {
  /** 現在有効なトークンハッシュ(未発行なら undefined = 全拒否) */
  getTokenHash: () => string | undefined;
  /** この回数連続で失敗したIPをバンする(既定 5) */
  maxFailures?: number;
  /** バン時間 ms(既定 60秒) */
  banMs?: number;
  /** テスト用の時刻注入 */
  now?: () => number;
}

const DEFAULT_MAX_FAILURES = 5;
const DEFAULT_BAN_MS = 60_000;

export class RemoteAuth {
  private readonly failures = new Map<string, { count: number; bannedUntil: number }>();

  constructor(private readonly opts: RemoteAuthOptions) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  verify(token: string | undefined, clientIp: string): AuthResult {
    const now = this.now();
    const entry = this.failures.get(clientIp);
    if (entry && entry.bannedUntil > now) return 'banned';

    const expectedHash = this.opts.getTokenHash();
    let ok = false;
    if (expectedHash && token) {
      const actual = Buffer.from(hashToken(token), 'hex');
      const expected = Buffer.from(expectedHash, 'hex');
      // hashToken は常に32バイトだが、config が壊れている場合に例外にしない
      ok = actual.length === expected.length && timingSafeEqual(actual, expected);
    }

    if (ok) {
      this.failures.delete(clientIp);
      return 'ok';
    }

    const count = (entry?.count ?? 0) + 1;
    const maxFailures = this.opts.maxFailures ?? DEFAULT_MAX_FAILURES;
    if (count >= maxFailures) {
      this.failures.set(clientIp, { count: 0, bannedUntil: now + (this.opts.banMs ?? DEFAULT_BAN_MS) });
    } else {
      this.failures.set(clientIp, { count, bannedUntil: 0 });
    }
    return 'unauthorized';
  }
}
