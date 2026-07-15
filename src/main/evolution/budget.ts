/**
 * M92-追加: 生成の予算ガード(累積キャップ2層)。
 *
 * A2(反復を厚く)を入れると、失敗ジョブがリトライで**静かにトークンを積み上げて**
 * Fable 5 の週枠を食い潰す恐れがある。守るべきは瞬間のスパイクではなく**累計**なので、
 * 上限は「秒間レート」ではなく「これまでに使った総量」で見る。2層で守る:
 *   - ジョブ単位キャップ: 1ツール生成が使えるトークン上限(1本の暴走リトライを止める)
 *   - セッション/夜間キャップ: 生成全体の合計上限(= Fable 5 週枠そのものを守る本命)
 *
 * 純粋なカウンタ。トークンの実測値(または概算)は呼び出し側が record する。
 * 上限 undefined/0 は「無制限」(既定=予算未設定なら従来どおり無制限で動く)。
 */

export interface BudgetLimits {
  /** 1ジョブの上限トークン(0/undefined=無制限) */
  perJobTokens?: number;
  /** セッション/夜間の合計上限トークン(0/undefined=無制限) */
  sessionTokens?: number;
}

export interface BudgetVerdict {
  ok: boolean;
  /** ok=false のとき、なぜ止めるか(ジョブの失敗理由・ユーザー表示に使う) */
  reason?: string;
}

export class GenerationBudget {
  private sessionSpentTokens = 0;

  constructor(private readonly limits: BudgetLimits = {}) {}

  /**
   * これから want トークン使ってよいか。jobSpent はこのジョブでこれまで使った量
   * (呼び出し側が保持して渡す)。どちらかの上限を超えるなら ok:false + 理由。
   */
  check(jobSpent: number, want: number): BudgetVerdict {
    const perJob = this.limits.perJobTokens;
    if (perJob !== undefined && perJob > 0 && jobSpent + want > perJob) {
      return { ok: false, reason: `ジョブのトークン上限(${perJob.toLocaleString()})に達したため生成を打ち切った` };
    }
    const session = this.limits.sessionTokens;
    if (session !== undefined && session > 0 && this.sessionSpentTokens + want > session) {
      return {
        ok: false,
        reason: `セッション/夜間のトークン上限(${session.toLocaleString()})に達したため生成を打ち切った(Fable 5 枠の保護)`,
      };
    }
    return { ok: true };
  }

  /** 実際に使った(または概算)トークンをセッション累計へ加える */
  record(tokens: number): void {
    if (Number.isFinite(tokens) && tokens > 0) this.sessionSpentTokens += tokens;
  }

  sessionSpent(): number {
    return this.sessionSpentTokens;
  }
}
