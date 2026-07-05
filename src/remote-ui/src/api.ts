import type {
  AgentStatusView,
  ApprovalDecision,
  ChatImageInput,
  ChatMode,
  EvolutionJobSummary,
  HistoryMessageView,
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

  /** SSE。切断時は EventSource が自動再接続し、再接続ごとに snapshot が届く */
  openEvents(): EventSource {
    return new EventSource(`/api/events?token=${encodeURIComponent(this.token)}`);
  }
}

const TOKEN_KEY = 'mycodex-remote-token';

/** URLフラグメント #t=<token> → localStorage の順でトークンを拾う */
export function loadToken(): string | null {
  const hash = window.location.hash;
  const m = /^#t=([0-9a-f]{64})$/.exec(hash);
  if (m && m[1]) {
    window.localStorage.setItem(TOKEN_KEY, m[1]);
    // トークンをURLに残さない(スクリーンショット・履歴対策)
    window.history.replaceState(null, '', window.location.pathname);
    return m[1];
  }
  return window.localStorage.getItem(TOKEN_KEY);
}

export function saveToken(token: string): void {
  window.localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  window.localStorage.removeItem(TOKEN_KEY);
}
