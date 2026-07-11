import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ApprovalBatch, OpsThreadMessage } from '../../shared/types';

/**
 * M33-4: ⛩ 運営スレッド — ユーザーと神議の会話場所(左ペイン常設・1本固定)。
 * 神議の承認バッチ・分析・通知はすべてここへカードとして届く(バラバラ通知の禁止)。
 * 追記型JSONL(userData/operations/thread.jsonl)。バッチの状態は batches.json に持つ。
 */

export type { OpsThreadMessage };

export class OpsThread {
  private readonly messagesPath: string;
  private readonly batchesPath: string;

  constructor(dir: string) {
    this.messagesPath = join(dir, 'thread.jsonl');
    this.batchesPath = join(dir, 'batches.json');
  }

  post(msg: Omit<OpsThreadMessage, 'id' | 'ts'>): OpsThreadMessage {
    const full: OpsThreadMessage = { ...msg, id: randomUUID(), ts: new Date().toISOString() };
    try {
      mkdirSync(dirname(this.messagesPath), { recursive: true });
      appendFileSync(this.messagesPath, `${JSON.stringify(full)}\n`, 'utf8');
    } catch {
      // スレッド書き込み失敗で処理を止めない
    }
    return full;
  }

  list(limit = 200): OpsThreadMessage[] {
    try {
      const lines = readFileSync(this.messagesPath, 'utf8')
        .split('\n')
        .filter((l) => l.trim() !== '');
      const out: OpsThreadMessage[] = [];
      for (const line of lines.slice(-Math.max(0, limit))) {
        try {
          const parsed = JSON.parse(line) as OpsThreadMessage;
          if (typeof parsed.id === 'string') out.push(parsed);
        } catch {
          // skip
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  // ---- 承認バッチ ----

  private readBatches(): ApprovalBatch[] {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.batchesPath, 'utf8'));
      return Array.isArray(parsed) ? (parsed as ApprovalBatch[]) : [];
    } catch {
      return [];
    }
  }

  private saveBatches(batches: ApprovalBatch[]): void {
    try {
      mkdirSync(dirname(this.batchesPath), { recursive: true });
      writeFileSync(this.batchesPath, JSON.stringify(batches, null, 1), 'utf8');
    } catch {
      // ベストエフォート
    }
  }

  addBatch(batch: ApprovalBatch): void {
    const all = this.readBatches();
    all.push(batch);
    this.saveBatches(all);
  }

  getBatch(id: string): ApprovalBatch | null {
    return this.readBatches().find((b) => b.id === id) ?? null;
  }

  listBatches(): ApprovalBatch[] {
    return this.readBatches();
  }

  /** バッチ項目への応答。適用処理は呼び出し側(manager)が行い、ここは状態のみ更新 */
  respondBatchItem(batchId: string, itemId: string, approved: boolean): ApprovalBatch | null {
    const all = this.readBatches();
    const batch = all.find((b) => b.id === batchId);
    const item = batch?.items.find((i) => i.id === itemId);
    if (!batch || !item) return null;
    item.status = approved ? 'approved' : 'rejected';
    this.saveBatches(all);
    return batch;
  }

  /** 未処理(pending項目を含む)バッチ数 = 左ペインの未読バッジ */
  pendingCount(): number {
    return this.readBatches().filter((b) => b.items.some((i) => i.status === 'pending')).length;
  }
}
