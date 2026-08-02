import type { WorldCommand, WorldPageEvent, WorldPushPayload, WorldStateSnapshot } from '../../shared/types';
import type { EventBus } from '../core/events';

/**
 * M115: 世界(WORLD)ブリッジ。エージェントの「身体・キャンバス」となる3D世界ページと
 * main プロセスを結ぶ。輸送は既存インフラのみ(新規依存ゼロ):
 * - main → ページ: EventBus 'world:event' → SSE(/api/events)
 * - ページ → main: POST /api/world/event(RemoteServer が onPageEvent へ渡す)
 *
 * 設計方針:
 * - 世界ページは複数開かれうる(PC+スマホ)。コマンドは全接続へ配り、ack は最初の1件を採用
 *   (全ページが同じ決定的コマンドを実行するので結果は同一。厳密な多端末同期はP2で扱う)
 * - 「接続中か」は最終受信からの経過時間で判定(ページは定期的に state を報告する)
 */

const CONNECT_TIMEOUT_MS = 30_000;
const ACK_TIMEOUT_MS = 12_000;
const CHAT_LOG_MAX = 30;

export class WorldManager {
  private seq = 0;
  private lastSeenMs = Number.NEGATIVE_INFINITY;
  private state: WorldStateSnapshot | null = null;
  private readonly pendingAcks = new Map<
    number,
    { resolve: (r: { ok: boolean; errors?: string[] }) => void; timer: NodeJS.Timeout }
  >();
  /** 世界内チャット(user/agent両方)。observe で最近分をエージェントへ見せる */
  private readonly chatLog: { from: 'user' | 'agent'; text: string }[] = [];
  private chatHandler: ((text: string) => void) | null = null;

  constructor(
    private readonly bus: EventBus,
    private readonly now: () => number = Date.now,
    private readonly ackTimeoutMs: number = ACK_TIMEOUT_MS,
  ) {}

  /** 世界内チャット到着時の処理(ipc.ts が service.chatSend へ橋渡しする)を注入 */
  setChatHandler(handler: (text: string) => void): void {
    this.chatHandler = handler;
  }

  isConnected(): boolean {
    return this.now() - this.lastSeenMs < CONNECT_TIMEOUT_MS;
  }

  /** RemoteServer から呼ばれる。世界ページからの全イベントの入口 */
  onPageEvent(ev: WorldPageEvent): { ok: boolean } {
    this.lastSeenMs = this.now();
    switch (ev.kind) {
      case 'hello':
      case 'state':
        if (ev.state) this.state = ev.state;
        return { ok: true };
      case 'chat': {
        if (typeof ev.text !== 'string' || ev.text.trim() === '') return { ok: false };
        this.pushChat('user', ev.text);
        this.chatHandler?.(ev.text);
        return { ok: true };
      }
      case 'ack': {
        if (ev.state) this.state = ev.state;
        const pending = this.pendingAcks.get(ev.seq);
        if (pending) {
          this.pendingAcks.delete(ev.seq);
          clearTimeout(pending.timer);
          pending.resolve({ ok: ev.ok, errors: ev.errors });
        }
        return { ok: true };
      }
      default:
        return { ok: false };
    }
  }

  /** world_observe ツールが返す内容 */
  observe(): { connected: boolean; state: WorldStateSnapshot | null; chat: { from: string; text: string }[] } {
    return { connected: this.isConnected(), state: this.state, chat: [...this.chatLog] };
  }

  /**
   * world_act ツールの実体。コマンド列をページへ押し出し、実行結果(ack)を待つ。
   * 未接続なら即座に失敗を返す(エージェントが延々待たないように)
   */
  act(cmds: WorldCommand[]): Promise<{ ok: boolean; detail: string }> {
    if (!this.isConnected()) {
      return Promise.resolve({
        ok: false,
        detail: '世界ページが未接続(world.html が開かれていないか、しばらく応答がない)。ユーザーに世界を開いてもらうこと。',
      });
    }
    for (const c of cmds) {
      if (c.type === 'say' && typeof c.text === 'string') this.pushChat('agent', c.text);
    }
    const seq = ++this.seq;
    const payload: WorldPushPayload = { seq, cmds };
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingAcks.delete(seq);
        resolve({ ok: false, detail: `世界ページからの応答なし(${this.ackTimeoutMs}ms)。ページが閉じられた可能性がある` });
      }, this.ackTimeoutMs);
      this.pendingAcks.set(seq, {
        resolve: (r) => resolve({ ok: r.ok, detail: r.ok ? `実行完了(${cmds.length}コマンド)` : `一部失敗: ${(r.errors ?? []).join(' / ')}` }),
        timer,
      });
      this.bus.publish('world:event', payload);
    });
  }

  private pushChat(from: 'user' | 'agent', text: string): void {
    this.chatLog.push({ from, text });
    if (this.chatLog.length > CHAT_LOG_MAX) this.chatLog.splice(0, this.chatLog.length - CHAT_LOG_MAX);
  }
}
