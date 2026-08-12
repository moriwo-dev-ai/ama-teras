/**
 * M173(C工事2/3): WorldRemoteClient — 分離した世界サーバ(world-server)へのアプリ側クライアント。
 *
 * アプリ(テラ)はもう世界を所有しない。世界の正本・実行係はworld-serverにあり、
 * このクライアントが「テラの身体」としてHTTP/SSEで世界に触れる。
 * - act/observe/chatHistory/onPageEvent: HTTP(合鍵=proxy key)
 * - SSEブリッジ: world-serverの観戦SSEを購読し、world:eventをアプリのバスへ再配布
 *   (スマホの表示・OBS観戦はアプリ経由のまま動く)。world:agent-chatはテラ起動コールバックへ
 * - 切断時は5秒ごと再接続。isConnected()はSSE生存で判定
 */
import type { EventBus } from '../core/events';
import type { WorldApp, WorldCommand, WorldPageEvent, WorldPushPayload, WorldStateSnapshot } from '../../shared/types';

export interface WorldObserveResult {
  connected: boolean;
  state: WorldStateSnapshot | null;
  chat: { from: string; text: string }[];
  apps?: WorldApp[];
  openApp?: string | null;
  howToSee?: string;
  howToApps?: string;
  resident?: string;
}

export class WorldRemoteClient {
  private sseAlive = false;
  private stopped = false;
  /** M201: 世界の復元スナップショット(15秒ごとに取り直す)。新規ページへ即渡す */
  private lastRestore: WorldPushPayload | null = null;
  private restoreTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly base: string,
    private readonly key: string,
    private readonly bus: EventBus,
    private readonly onAgentChat: (text: string) => void,
  ) {}

  start(): void {
    void this.connectSse();
    void this.refreshRestore();
    this.restoreTimer = setInterval(() => { void this.refreshRestore(); }, 15_000);
  }

  stop(): void {
    this.stopped = true;
    if (this.restoreTimer !== null) { clearInterval(this.restoreTimer); this.restoreTimer = null; }
  }

  isConnected(): boolean {
    return this.sseAlive;
  }

  private async connectSse(): Promise<void> {
    while (!this.stopped) {
      try {
        const res = await fetch(`${this.base}/api/world/spectate`, { headers: { accept: 'text/event-stream' } });
        if (!res.ok || res.body === null) throw new Error(`spectate ${res.status}`);
        this.sseAlive = true;
        console.log('[worldClient] 世界サーバSSE接続');
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const ev = /^event: (.+)$/m.exec(block)?.[1];
            const dataLine = /^data: (.+)$/m.exec(block)?.[1];
            if (ev === undefined || dataLine === undefined) continue;
            try {
              const payload: unknown = JSON.parse(dataLine);
              if (ev === 'world:event') this.bus.publish('world:event', payload as WorldPushPayload);
              else if (ev === 'world:chat') this.bus.publish('world:chat', payload as { from: 'user'; text: string });
              else if (ev === 'world:agent-chat') this.onAgentChat((payload as { text: string }).text);
            } catch {
              /* 非JSONは無視 */
            }
          }
        }
      } catch {
        /* 接続失敗は下で再試行 */
      }
      this.sseAlive = false;
      if (this.stopped) return;
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }

  private async post(path: string, body: unknown): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.base}${path}?k=${this.key}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(95_000),
    });
    return (await res.json().catch(() => ({}))) as Record<string, unknown>;
  }

  async act(cmds: WorldCommand[]): Promise<{ ok: boolean; detail: string }> {
    try {
      const r = await this.post('/api/world/act', { cmds });
      return { ok: r['ok'] === true, detail: String(r['detail'] ?? '') };
    } catch (e) {
      return { ok: false, detail: `世界サーバに届かない: ${String(e).slice(0, 80)}` };
    }
  }

  async observe(): Promise<WorldObserveResult> {
    try {
      const res = await fetch(`${this.base}/api/world/state?k=${this.key}`, { signal: AbortSignal.timeout(10_000) });
      return (await res.json()) as WorldObserveResult;
    } catch {
      return { connected: false, state: null, chat: [] };
    }
  }

  async chatHistory(limit = 200): Promise<{ from: string; text: string; ts?: string }[]> {
    try {
      const res = await fetch(`${this.base}/api/world/chatlog?k=${this.key}&limit=${limit}`, { signal: AbortSignal.timeout(10_000) });
      const j = (await res.json()) as { log?: { from: string; text: string; ts?: string }[] };
      return j.log ?? [];
    } catch {
      return [];
    }
  }

  async onPageEvent(ev: WorldPageEvent): Promise<{ ok: boolean }> {
    try {
      const r = await this.post('/api/world/event', ev);
      return { ok: r['ok'] === true };
    } catch {
      return { ok: false };
    }
  }

  /**
   * M201: 世界の復元スナップショット。以前はnullを返していたため、アプリ経由で開いたページは
   * 「他の誰かがhelloを送って押し出しが起きる」まで空の世界のままだった(実測: スマホで建物が出ない)。
   * world-serverから定期取得してキャッシュし、接続の瞬間に必ず世界を渡す
   */
  restorePayload(): WorldPushPayload | null {
    return this.lastRestore;
  }

  private async refreshRestore(): Promise<void> {
    try {
      const res = await fetch(`${this.base}/api/world/restore?k=${this.key}`, { signal: AbortSignal.timeout(10_000) });
      const j = (await res.json()) as { restore?: WorldPushPayload | null };
      if (j.restore !== null && j.restore !== undefined) this.lastRestore = j.restore;
    } catch { /* 次の周期で取り直す */ }
  }

  /** 世界へのお知らせ(承認待ち等)。テラの声として世界に出す */
  notify(text: string): void {
    void this.act([{ type: 'say', text } as WorldCommand]);
  }
}
