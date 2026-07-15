import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * M92-Phase0: 生成の計測土台。「Claude Code級に近づいたか」を測る物差しが無ければ、
 * どのレバー(A1手本/A2反復/…)が効いたか分からない。ジョブの結末を1行ずつ追記し、
 * 成功率・合格までの試行回数・所要時間・打ち切り理由を後から集計できるようにする。
 *
 * ここは記録と集計だけ(ライブ実行はしない)。ベースライン取得は実際に生成を回すときに埋まる。
 */

export type GenerationOutcome = 'promoted' | 'failed' | 'rejected' | 'cancelled' | 'rolled_back';

export interface GenerationRecord {
  jobId: number;
  scope: string;
  toolName?: string;
  outcome: GenerationOutcome;
  /** 生成→ゲートを回した回数(粘りの深さ) */
  attempts: number;
  durationMs: number;
  /** 失敗時のゲート名など(何で落ちたかの内訳集計用) */
  failureKinds?: string[];
  /** 予算で打ち切ったか */
  budgetStopped?: boolean;
  at: string;
}

export interface MetricsSummary {
  total: number;
  promoted: number;
  /** promoted / total(0〜1) */
  successRate: number;
  /** 成功したジョブの平均試行回数 */
  avgAttemptsOnSuccess: number;
  avgDurationMs: number;
  /** outcome ごとの件数 */
  byOutcome: Record<string, number>;
  /** 失敗の内訳(failureKinds の出現回数) */
  failureKinds: Record<string, number>;
}

export class GenerationMetrics {
  constructor(private readonly file: string) {}

  /** 1件追記(JSON Lines)。計測は本流を止めてはいけないので、失敗は握って捨てる */
  record(rec: GenerationRecord): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      appendFileSync(this.file, `${JSON.stringify(rec)}\n`, 'utf8');
    } catch {
      /* 計測失敗で生成を止めない */
    }
  }

  /** 全記録を読む(壊れた行は飛ばす) */
  read(): GenerationRecord[] {
    if (!existsSync(this.file)) return [];
    const out: GenerationRecord[] = [];
    for (const line of readFileSync(this.file, 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      try {
        out.push(JSON.parse(line) as GenerationRecord);
      } catch {
        /* 壊れた行は無視 */
      }
    }
    return out;
  }

  summary(): MetricsSummary {
    return summarize(this.read());
  }
}

/** 集計(純関数。テスト・レポート表示から直接使える) */
export function summarize(records: GenerationRecord[]): MetricsSummary {
  const total = records.length;
  const byOutcome: Record<string, number> = {};
  const failureKinds: Record<string, number> = {};
  let promoted = 0;
  let successAttempts = 0;
  let durationSum = 0;
  for (const r of records) {
    byOutcome[r.outcome] = (byOutcome[r.outcome] ?? 0) + 1;
    durationSum += r.durationMs;
    if (r.outcome === 'promoted') {
      promoted++;
      successAttempts += r.attempts;
    }
    for (const k of r.failureKinds ?? []) failureKinds[k] = (failureKinds[k] ?? 0) + 1;
  }
  return {
    total,
    promoted,
    successRate: total === 0 ? 0 : promoted / total,
    avgAttemptsOnSuccess: promoted === 0 ? 0 : successAttempts / promoted,
    avgDurationMs: total === 0 ? 0 : durationSum / total,
    byOutcome,
    failureKinds,
  };
}
