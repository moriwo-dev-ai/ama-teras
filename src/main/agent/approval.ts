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

  constructor(private readonly pushToRenderer: (req: ApprovalRequestPayload) => void) {}

  request(req: Omit<ApprovalRequestPayload, 'id'>): Promise<ApprovalDecision> {
    const id = randomUUID();
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.pushToRenderer({ ...req, id });
    });
  }

  respond(id: string, decision: ApprovalDecision): void {
    const resolve = this.pending.get(id);
    if (!resolve) return;
    this.pending.delete(id);
    resolve(decision);
  }

  allowForSession(toolName: string): void {
    this.sessionAllowed.add(toolName);
  }

  isSessionAllowed(toolName: string): boolean {
    return this.sessionAllowed.has(toolName);
  }

  resetSession(): void {
    this.sessionAllowed.clear();
    // 未応答の承認は拒否として解決(ダイアログの取り残し防止)
    for (const resolve of this.pending.values()) resolve('deny');
    this.pending.clear();
  }
}
