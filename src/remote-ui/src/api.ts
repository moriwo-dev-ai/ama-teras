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

  /** SSE。切断時は EventSource が自動再接続し、再接続ごとに snapshot が届く */
  openEvents(): EventSource {
    return new EventSource(`/api/events?token=${encodeURIComponent(this.token)}`);
  }
}

const TOKEN_KEY = 'mycodex-remote-token';

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
  return window.localStorage.getItem(TOKEN_KEY);
}

export function saveToken(token: string): void {
  window.localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  window.localStorage.removeItem(TOKEN_KEY);
}
