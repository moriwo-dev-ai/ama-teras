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
 * M110: 課金/残高エラーの行動可能な案内文(純関数)。
 * 実機事故: クレジット枯渇時に生のJSON 400がカードに出るだけで、
 * 「何をすれば動くのか」が読み取れず復旧がオーナーの調査待ちになった。
 * - keyedProviders: キー登録済みの代替プロバイダ(現在のを除く)
 * - mismatchProvider: 現在のmodelが実は別プロバイダの既知IDだった場合そのID
 */
export function billingGuidance(
  current: { provider: string; model: string },
  keyedProviders: { id: string; label: string }[],
  mismatch: { provider: string; label: string } | null,
  rawError: string,
): string {
  const lines: string[] = [
    `${current.provider} のAPI残高/課金エラーです(モデル: ${current.model})。このままでは実行できません。`,
  ];
  if (mismatch !== null) {
    lines.push(
      `※モデル「${current.model}」は ${mismatch.label} のモデルIDです。Provider設定(${current.provider})と食い違っています — 設定→基本タブでProviderを ${mismatch.label} に合わせるだけで直る可能性があります。`,
    );
  }
  const alt =
    keyedProviders.length > 0
      ? `別プロバイダへ切替(キー登録済み: ${keyedProviders.map((p) => p.label).join(' / ')})、`
      : '';
  lines.push(`対処: 設定→基本タブで ${alt}残高の補充、または設定でフォールバック先を有効化(自動切替)。`);
  lines.push(`(元エラー: ${rawError})`);
  return lines.join('\n');
}

/**
 * M113-1: エラーから「何ミリ秒後に再試行すべきか」を取り出す(取れなければ null)。
 * 優先順: ①retry-after ヘッダ(秒数 or HTTP-date) ②Groq/Gemini系がメッセージに埋める
 * "Please try again in 1.234s" / "in 20ms" / "in 2m30s" 形式。
 * 一晩モードの待機時間の一次情報源(無ければ段階スケジュールに落ちる)
 */
export function retryAfterMs(err: unknown): number | null {
  const rec = typeof err === 'object' && err !== null ? (err as Record<string, unknown>) : {};
  const headers = rec['headers'];
  let raw: string | null = null;
  if (headers instanceof Headers) raw = headers.get('retry-after');
  else if (typeof headers === 'object' && headers !== null) {
    const h = headers as Record<string, unknown>;
    const v = h['retry-after'] ?? h['Retry-After'];
    if (typeof v === 'string') raw = v;
  }
  if (raw !== null) {
    const secs = Number(raw);
    if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000);
    const date = Date.parse(raw);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  const message = err instanceof Error ? err.message : String(err);
  // "try again in 1.2s" / "in 250ms" / "in 2m30.5s"(Groq実物は m+s 複合形式を使う)。
  // 分の 'm' は 'ms' の m と衝突するため負の先読みで区別する
  const m = /try again in\s+(?:(\d+)m(?!s))?([\d.]+)?(ms|s)?/i.exec(message);
  if (m && (m[1] !== undefined || m[2] !== undefined)) {
    const minutes = m[1] !== undefined ? Number(m[1]) : 0;
    const rest = m[2] !== undefined ? Number(m[2]) : 0;
    const unit = m[3]?.toLowerCase();
    const restMs = unit === 'ms' ? rest : rest * 1000;
    const total = minutes * 60_000 + restMs;
    if (Number.isFinite(total) && total > 0) return Math.round(total);
  }
  return null;
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
