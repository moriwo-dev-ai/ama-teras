import type {
  AgentStatusView,
  ApprovalDecision,
  ChatImageInput,
  ChatMode,
  EvolutionJobSummary,
  HistoryMessageView,
  SessionLoadResult,
  SessionMeta,
  ToolInfo,
} from '../../shared/types';

/**
 * M10-4: リモートAPIクライアント。fetch + EventSource のみ(window.api には依存しない)。
 * トークンは REST では Authorization ヘッダ、SSE ではクエリで送る(EventSource の制約)。
 */

/** audit.jsonl の1行(main の AuditEntry と同形。remote-ui は shared 以外を import しない) */
export interface AuditEntryView {
  ts: string;
  tool: string;
  scope: string;
  paths: string[];
  event: string;
  detail: string;
}

export class RemoteApi {
  constructor(private readonly token: string) {}

  private async req<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const parsed = (await res.json()) as { error?: string };
        if (parsed.error) detail = parsed.error;
      } catch {
        /* JSONでないエラー本文は無視 */
      }
      throw new Error(detail);
    }
    return (await res.json()) as T;
  }

  status(): Promise<AgentStatusView> {
    return this.req('GET', '/api/status');
  }

  chatSend(text: string, mode: ChatMode, images?: ChatImageInput[]): Promise<{ sessionId: string }> {
    return this.req('POST', '/api/chat', { text, mode, ...(images ? { images } : {}) });
  }

  chatCancel(sessionId: string): Promise<{ ok: boolean }> {
    return this.req('POST', '/api/chat/cancel', { sessionId });
  }

  /** M15.1: セッション一覧と切替(切替はworkspace追従込み。実行中はサーバ側で拒否される) */
  sessionsList(): Promise<{ sessions: SessionMeta[] }> {
    return this.req('GET', '/api/sessions');
  }

  sessionsLoad(id: string): Promise<SessionLoadResult> {
    return this.req('POST', '/api/sessions/load', { id });
  }

  /** M23-3: 新規チャット(M22で実行中でもブロックされない) */
  sessionsNew(): Promise<{ ok: boolean; message?: string }> {
    return this.req('POST', '/api/sessions/new');
  }

  /** M23-2: 使用量サマリ(残高に準ずるもの) */
  usage(): Promise<import('../../shared/types').UsageSummary> {
    return this.req('GET', '/api/usage');
  }

  /** M23-3: 設定の取得/変更(サーバ側ホワイトリストの安全なサブセットのみ) */
  settingsGet(): Promise<Record<string, unknown>> {
    return this.req('GET', '/api/settings');
  }

  settingsSet(patch: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.req('POST', '/api/settings', patch);
  }

  approvalRespond(id: string, decision: ApprovalDecision): Promise<{ ok: boolean }> {
    return this.req('POST', '/api/approval/respond', { id, decision });
  }

  toolsList(): Promise<{ tools: ToolInfo[] }> {
    return this.req('GET', '/api/tools');
  }

  history(): Promise<{ messages: HistoryMessageView[] }> {
    return this.req('GET', '/api/history');
  }

  evolutionList(): Promise<{ jobs: EvolutionJobSummary[] }> {
    return this.req('GET', '/api/evolution');
  }

  evolutionEnqueue(description: string, expectedIO: string): Promise<{ jobId: number }> {
    return this.req('POST', '/api/evolution/enqueue', { description, expectedIO });
  }

  evolutionPromoteRespond(jobId: number, approved: boolean): Promise<{ ok: boolean }> {
    return this.req('POST', '/api/evolution/promote-respond', { jobId, approved });
  }

  auditTail(limit = 100): Promise<{ entries: AuditEntryView[] }> {
    return this.req('GET', `/api/audit?limit=${limit}`);
  }

  /** M17-2: 自律モード切替。ON はリスク確認済みフラグをサーバが必須にする */
  setAutonomous(on: boolean, confirmed?: boolean): Promise<{ on: boolean }> {
    return this.req('POST', '/api/autonomous', { on, ...(confirmed ? { confirmed: true } : {}) });
  }

  // ---- M34-6: 運営(TAKAMA-gahara)。オーナーモードOFF時は enabled:false ----

  opsSummary(): Promise<{
    enabled: boolean;
    clocks: import('../../shared/types').GodClockJob[];
    inbox: (import('../../shared/types').InboxItem & { read: boolean })[];
    latest: import('../../shared/types').MetricsSnapshot | null;
    pendingIwato: import('../../shared/types').IwatoRequestPayload[];
  }> {
    return this.req('GET', '/api/ops/summary');
  }

  opsThread(): Promise<{ messages: import('../../shared/types').OpsThreadMessage[] }> {
    return this.req('GET', '/api/ops/thread');
  }

  opsThreadSend(text: string): Promise<{ messages: import('../../shared/types').OpsThreadMessage[] }> {
    return this.req('POST', '/api/ops/thread', { text });
  }

  opsBatches(): Promise<{ batches: import('../../shared/types').ApprovalBatch[] }> {
    return this.req('GET', '/api/ops/batches');
  }

  opsBatchRespond(batchId: string, itemId: string, approved: boolean): Promise<{ ok: boolean; detail: string }> {
    return this.req('POST', '/api/ops/batch-respond', { batchId, itemId, approved });
  }

  opsIwatoRespond(id: string, approved: boolean): Promise<{ ok: boolean }> {
    return this.req('POST', '/api/ops/iwato-respond', { id, approved });
  }

  // ---- M40: スマホからのフル操作(デスクトップの運営タブ相当)----

  /** M39: 同種の一括承認。X/はてブは links が返るのでスマホのブラウザで開く */
  opsBulkRespond(
    batchId: string,
    itemIds: string[],
    approved: boolean,
  ): Promise<import('../../shared/operations').BulkRespondResult> {
    return this.req('POST', '/api/ops/bulk-respond', { batchId, itemIds, approved });
  }

  opsDrafts(): Promise<{
    drafts: import('../../shared/types').OperationsDraft[];
    impacts: import('../../shared/types').ImpactEntry[];
    repos: string[];
  }> {
    return this.req('GET', '/api/ops/drafts');
  }

  opsDraftUpdate(
    id: string,
    patch: { status?: 'draft' | 'posted' | 'discarded'; media?: string },
  ): Promise<import('../../shared/types').OperationsDraft | null> {
    return this.req('POST', '/api/ops/draft-update', { id, patch });
  }

  opsDraftRelease(draftId: string, repo: string, tag: string): Promise<{ ok: boolean; detail: string }> {
    return this.req('POST', '/api/ops/draft-release', { draftId, repo, tag });
  }

  opsDraftZenn(draftId: string): Promise<{ ok: boolean; detail: string }> {
    return this.req('POST', '/api/ops/draft-zenn', { draftId });
  }

  opsClockUpdate(
    id: string,
    patch: { intervalMin?: number; enabled?: boolean; dailyTokenBudget?: number; budgetSetByUser?: boolean },
  ): Promise<import('../../shared/types').GodClockJob | null> {
    return this.req('POST', '/api/ops/clock-update', { id, patch });
  }

  /** 神を今すぐ1回動かす(観測/下書き生成/トリアージ/神議) */
  opsGodRun(godId: string): Promise<{ ok: boolean; detail: string; tokensUsed: number }> {
    return this.req('POST', '/api/ops/god-run', { godId });
  }

  /** SSE。切断時は EventSource が自動再接続し、再接続ごとに snapshot が届く */
  openEvents(): EventSource {
    return new EventSource(`/api/events?token=${encodeURIComponent(this.token)}`);
  }
}

const TOKEN_KEY = 'amateras-remote-token';
/** M27-7: 旧称キー(移行元としてのみ参照。loadToken が一回きりで新キーへ移す) */
const LEGACY_TOKEN_KEY = 'mycodex-remote-token';

/**
 * M15.1: フラグメントからのトークン抽出(純関数・テスト可能)。
 * iOSのホーム画面起動などでフラグメントに余計な要素が付いても拾えるよう、
 * 先頭一致でなく `t=<64hex>` の出現で判定する
 */
export function extractTokenFromHash(hash: string): string | null {
  const m = /[#?&]t=([0-9a-f]{64})(?:[&#]|$)/.exec(hash);
  return m?.[1] ?? null;
}

/** URLフラグメント #t=<token> → localStorage の順でトークンを拾う */
export function loadToken(): string | null {
  const fromHash = extractTokenFromHash(window.location.hash);
  if (fromHash) {
    // PWA(ホーム画面)はSafariと保存領域が別のため、この保存が初回起動の鍵になる
    window.localStorage.setItem(TOKEN_KEY, fromHash);
    // M15.1: フラグメントは削除しない(ユーザー決定)。iOSの「ホーム画面に追加」は
    // 追加時点のURLを保存するため、ここで消すとPWA初回起動でトークンが失われる。
    // トークンはURLフラグメントのままサーバへは送信されず、端末内(Tailscale内)に留まる
    return fromHash;
  }
  const current = window.localStorage.getItem(TOKEN_KEY);
  if (current !== null) return current;
  // M27-7: 旧称キーからの一回きり移行(再ログイン不要にする)
  const legacy = window.localStorage.getItem(LEGACY_TOKEN_KEY);
  if (legacy !== null) {
    window.localStorage.setItem(TOKEN_KEY, legacy);
    window.localStorage.removeItem(LEGACY_TOKEN_KEY);
  }
  return legacy;
}

export function saveToken(token: string): void {
  window.localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  window.localStorage.removeItem(TOKEN_KEY);
}
