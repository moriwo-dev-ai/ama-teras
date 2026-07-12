import { randomUUID } from 'node:crypto';
import type { ApprovalDecision, ApprovalRequestPayload } from '../../shared/types';

/**
 * ツール実行承認の待ち合わせ。main側で Promise を保持し、
 * renderer の承認ダイアログからの応答(approval:respond)で解決する。
 * 'allow-session' の登録は決定を受け取った executor 側が allowForSession() で行う。
 */
export class ApprovalBroker {
  private pending = new Map<string, (decision: ApprovalDecision) => void>();
  private sessionAllowed = new Set<string>();

  constructor(
    private readonly pushToRenderer: (req: ApprovalRequestPayload) => void,
    /** M10: 解決(respond / abort / resetSession)の通知。開いたままの他画面のダイアログを閉じるのに使う */
    private readonly onSettled?: (id: string, decision: ApprovalDecision) => void,
  ) {}

  /**
   * 承認を要求する。signal が渡され、待機中に abort されたら 'deny' で解決する
   * (キャンセルしても承認待ちが未解決のまま残りループがハングするのを防ぐ)。
   */
  request(req: Omit<ApprovalRequestPayload, 'id'>, signal?: AbortSignal): Promise<ApprovalDecision> {
    if (signal?.aborted) return Promise.resolve('deny');
    const id = randomUUID();
    return new Promise((resolve) => {
      const settle = (decision: ApprovalDecision): void => {
        if (!this.pending.has(id)) return; // 二重解決を防ぐ(respond と abort の競合)
        this.pending.delete(id);
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve(decision);
        this.onSettled?.(id, decision);
      };
      const onAbort = (): void => settle('deny');
      this.pending.set(id, settle);
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      this.pushToRenderer({ ...req, id });
    });
  }

  respond(id: string, decision: ApprovalDecision): void {
    const settle = this.pending.get(id);
    if (settle) settle(decision);
  }

  /** M42-2(TUKU-yomi): 未応答の承認要求の件数(月読が「承認待ちがあるよ」と言うため。読み取りのみ) */
  pendingCount(): number {
    return this.pending.size;
  }

  allowForSession(toolName: string): void {
    this.sessionAllowed.add(toolName);
  }

  isSessionAllowed(toolName: string): boolean {
    return this.sessionAllowed.has(toolName);
  }

  resetSession(): void {
    this.sessionAllowed.clear();
    // 未応答の承認は拒否として解決(ダイアログの取り残し防止)。
    // settle は pending を書き換えるためスナップショットしてから回す。
    for (const settle of [...this.pending.values()]) settle('deny');
    this.pending.clear();
  }
}
