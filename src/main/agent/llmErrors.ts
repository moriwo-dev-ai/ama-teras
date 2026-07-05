/**
 * M16-2: LLM APIエラーの分類。
 * - billing: 残高枯渇・課金系。リトライ無意味 → フォールバック対象。
 *   ※OpenAIの insufficient_quota は 429 で来るため、429判定より先に見る
 * - transient: 一時エラー(レート制限・5xx・ネットワーク)→ 指数バックオフでリトライ
 * - fatal: それ以外(不正リクエスト等)→ 即時停止(従来どおり)
 */

export type LLMErrorKind = 'billing' | 'transient' | 'fatal';

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

  if (status !== null && TRANSIENT_STATUS.has(status)) return 'transient';
  // プロバイダ層がメッセージ文字列に押し込むケース(例: "429 {...}")
  if (/(^|[^0-9])(408|429|500|502|503|504|529)([^0-9]|$)/.test(message)) return 'transient';
  if (TRANSIENT_MSG_RE.test(message)) return 'transient';

  return 'fatal';
}

/** 情報カード用の短いエラー表記 */
export function shortLLMError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.length > 140 ? `${message.slice(0, 140)}…` : message;
}
