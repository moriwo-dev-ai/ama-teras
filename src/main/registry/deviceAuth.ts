import { systemFetch } from '../providers/systemFetch';
import type { FetchLike } from './github';

/**
 * M91-6: GitHub Device Flow(ブラウザ認証)。
 *
 * PAT(`ghp_...`)を手作りさせるのは、一般ユーザーには重い。Device Flow なら
 * 「ボタン → 表示されたコードをブラウザで入れて承認 → 完了」で、トークンのコピペが要らない。
 *
 * 仕組み上の要点:
 * - **Client ID は公開情報**(秘密ではない)。だからアプリに同梱してよい。Device Flow は
 *   Client Secret を使わない(=秘密を持てないデバイス向けの認可)。これが PAT より安全な理由
 * - 得られる user access token(`gho_...`)は、以降 PAT と同じく Bearer で使える。
 *   だから公開・要望の既存コード(secrets 'github' を読む部分)はそのまま動く
 *
 * fetch は systemFetch(Electron net.fetch)経由 — 法人プロキシ・証明書ストアの内側でも通す(M88)
 */

const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';

export interface DeviceCodeResult {
  deviceCode: string;
  /** 人間がブラウザに入れるコード(例 WDJB-MJHT) */
  userCode: string;
  /** コードを入れるページ(https://github.com/login/device) */
  verificationUri: string;
  expiresInSec: number;
  intervalSec: number;
}

async function postForm(url: string, params: Record<string, string>, fetchFn: FetchLike): Promise<Record<string, unknown>> {
  const res = await fetchFn(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'AMA-teras',
    },
    body: new URLSearchParams(params).toString(),
  });
  const text = await res.text();
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`GitHub の応答を解釈できない(${res.status}): ${text.slice(0, 160)}`);
  }
  return json;
}

/** 認証を開始してデバイスコードを得る(この user_code をユーザーに見せ、ブラウザで承認させる) */
export async function requestDeviceCode(
  clientId: string,
  scope: string,
  fetchFn: FetchLike = systemFetch(),
): Promise<DeviceCodeResult> {
  const j = await postForm(DEVICE_CODE_URL, { client_id: clientId, scope }, fetchFn);
  if (typeof j['error'] === 'string') {
    // 典型: OAuth App で Device Flow が無効("device_flow_disabled")、Client ID 不正
    throw new Error(
      `デバイス認証を開始できない: ${String(j['error_description'] ?? j['error'])}` +
        (j['error'] === 'device_flow_disabled'
          ? '(OAuth App の設定で "Enable Device Flow" を有効にしてください)'
          : ''),
    );
  }
  const deviceCode = j['device_code'];
  const userCode = j['user_code'];
  const verificationUri = j['verification_uri'];
  if (typeof deviceCode !== 'string' || typeof userCode !== 'string' || typeof verificationUri !== 'string') {
    throw new Error('GitHub の応答にデバイスコードが無い(Client ID を確認してください)');
  }
  return {
    deviceCode,
    userCode,
    verificationUri,
    expiresInSec: typeof j['expires_in'] === 'number' ? j['expires_in'] : 900,
    intervalSec: typeof j['interval'] === 'number' ? j['interval'] : 5,
  };
}

export type PollOutcome =
  | { ok: true; token: string; scope: string }
  | { ok: false; reason: string };

export interface PollDeps {
  intervalSec: number;
  expiresInSec: number;
  fetchFn?: FetchLike;
  /** テスト用注入(既定は実時間) */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * ユーザーが承認するまで待つ。GitHub の作法どおり interval を守り、slow_down は間隔を広げる。
 * 期限切れ・拒否はエラーとして返す(黙って待ち続けない)
 */
export async function pollForToken(
  clientId: string,
  deviceCode: string,
  deps: PollDeps,
): Promise<PollOutcome> {
  const fetchFn = deps.fetchFn ?? systemFetch();
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? ((): number => Date.now());
  const deadline = now() + deps.expiresInSec * 1000;
  let interval = Math.max(5, deps.intervalSec); // GitHub の最小は5秒

  for (;;) {
    if (now() >= deadline) return { ok: false, reason: 'コードの有効期限が切れた(もう一度やり直してください)' };
    await sleep(interval * 1000);
    const j = await postForm(
      ACCESS_TOKEN_URL,
      {
        client_id: clientId,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      },
      fetchFn,
    );
    if (typeof j['access_token'] === 'string') {
      return { ok: true, token: j['access_token'], scope: typeof j['scope'] === 'string' ? j['scope'] : '' };
    }
    const error = typeof j['error'] === 'string' ? j['error'] : 'unknown_error';
    if (error === 'authorization_pending') continue; // まだ承認していない
    if (error === 'slow_down') {
      // GitHub が「速すぎる」と言ったら間隔を広げる(返ってきた interval があればそれに従う)
      interval = typeof j['interval'] === 'number' ? j['interval'] : interval + 5;
      continue;
    }
    if (error === 'expired_token') return { ok: false, reason: 'コードの有効期限が切れた(もう一度やり直してください)' };
    if (error === 'access_denied') return { ok: false, reason: 'ブラウザで承認が拒否された' };
    return { ok: false, reason: String(j['error_description'] ?? error) };
  }
}
