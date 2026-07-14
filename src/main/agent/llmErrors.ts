/**
 * M16-2: LLM APIエラーの分類。
 * - billing: 残高枯渇・課金系。リトライ無意味 → フォールバック対象。
 *   ※OpenAIの insufficient_quota は 429 で来るため、429判定より先に見る
 * - transient: 一時エラー(レート制限・5xx・ネットワーク)→ 指数バックオフでリトライ
 * - fatal: それ以外(不正リクエスト等)→ 即時停止(従来どおり)
 */

export type LLMErrorKind = 'billing' | 'transient' | 'model_unavailable' | 'fatal';

const BILLING_RE =
  /credit balance|insufficient_quota|exceeded your current quota|billing|payment required|plans & billing/i;

const TRANSIENT_MSG_RE =
  /overloaded|rate.?limit|timeout|timed.?out|econnreset|econnrefused|etimedout|enotfound|fetch failed|network|socket hang up|server_error|api_error|service unavailable/i;

const TRANSIENT_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);

function statusOf(err: unknown): number | null {
  if (typeof err !== 'object' || err === null) return null;
  const rec = err as Record<string, unknown>;
  for (const key of ['status', 'statusCode']) {
    const v = rec[key];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

export function classifyLLMError(err: unknown): LLMErrorKind {
  const message = err instanceof Error ? err.message : String(err);
  const status = statusOf(err);

  // 課金系を最優先(429/400のステータスで来ても billing として扱う)
  if (BILLING_RE.test(message)) return 'billing';
  if (status === 402) return 'billing';

  // M30-2: モデル未開放/不存在(404)。新モデルの段階開放でアカウント未開放だと発生する
  if (isModelUnavailableError(err)) return 'model_unavailable';

  if (status !== null && TRANSIENT_STATUS.has(status)) return 'transient';
  // プロバイダ層がメッセージ文字列に押し込むケース(例: "429 {...}")
  if (/(^|[^0-9])(408|429|500|502|503|504|529)([^0-9]|$)/.test(message)) return 'transient';
  if (TRANSIENT_MSG_RE.test(message)) return 'transient';

  return 'fatal';
}

/**
 * M88: 通信が張れなかった原因(cause)を取り出す。
 *
 * OpenAI SDK は fetch が落ちると **"Connection error." としか言わない**。本当の原因
 * (ENOTFOUND=名前が引けない / ETIMEDOUT=届かない / ECONNREFUSED=拒否 /
 * 証明書エラー=TLS傍受・時計ズレ)は err.cause の中にいる。実機の別PCで
 * 「Connection error.」だけが出て、原因が何も分からず手が止まった。握りつぶさない
 */
export function causeChain(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let i = 0; i < 5 && typeof cur === 'object' && cur !== null; i++) {
    const rec = cur as Record<string, unknown>;
    const code = rec['code'] ?? rec['errno'];
    const msg = typeof rec['message'] === 'string' ? rec['message'] : undefined;
    const label = [typeof code === 'string' || typeof code === 'number' ? String(code) : undefined, msg]
      .filter((s): s is string => s !== undefined && s !== '')
      .join(': ');
    if (label !== '' && !parts.includes(label)) parts.push(label);
    cur = rec['cause'];
  }
  // 先頭は err 自身のメッセージなので、原因側(2つ目以降)だけを返す
  return parts.slice(1).join(' ← ');
}

/** 情報カード用の短いエラー表記 */
export function shortLLMError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const cause = causeChain(err);
  const full = cause === '' ? message : `${message}(原因: ${cause})`;
  return full.length > 200 ? `${full.slice(0, 200)}…` : full;
}

/**
 * M30-2: 「モデルが存在しない/アカウントに未開放」エラーか。
 * - OpenAI: 404 + "The model 'X' does not exist or you do not have access to it"
 *   (error.code === 'model_not_found')
 * - Anthropic: 404 not_found_error + "model: X"
 * 新モデルはGA後もアカウントのティア/ロールアウト状況で段階開放のため、
 * 既定モデルが未開放の環境がありうる(実機で確認された事象)
 */
export function isModelUnavailableError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const rec = typeof err === 'object' && err !== null ? (err as Record<string, unknown>) : {};
  const body = typeof rec['error'] === 'object' && rec['error'] !== null ? (rec['error'] as Record<string, unknown>) : {};
  if (body['code'] === 'model_not_found') return true;
  const is404 = statusOf(err) === 404 || /(^|[^0-9])404([^0-9]|$)/.test(message);
  return is404 && /model/i.test(message);
}

/**
 * M27-1: レート制限(429)か。無料APIモードのプリセット別の平易な文言に
 * 差し替える判定に使う(billing優先の分類とは独立に「429らしさ」だけを見る)
 */
export function isRateLimitError(err: unknown): boolean {
  if (statusOf(err) === 429) return true;
  const message = err instanceof Error ? err.message : String(err);
  return /(^|[^0-9])429([^0-9]|$)/.test(message) || /rate.?limit/i.test(message);
}
