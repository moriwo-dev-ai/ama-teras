import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ScopeAuditEvent } from './tools/executor';

/**
 * M9-4: system スコープ操作の監査ログ。userData/audit.jsonl に1行1イベントで追記する。
 * M10 のスマホUIから閲覧する前提のため、機械可読な JSONL にしている。
 * electron 非依存(ファイルパスを注入)でテスト可能にする。
 */

export interface AuditEntry extends ScopeAuditEvent {
  /** ISO 8601 */
  ts: string;
}

export class AuditLog {
  constructor(private readonly filePath: string) {}

  /** 追記に失敗してもツール実行は止めない(監査はベストエフォート。UIに影響させない) */
  append(event: ScopeAuditEvent): void {
    try {
      const entry: AuditEntry = { ts: new Date().toISOString(), ...event };
      mkdirSync(dirname(this.filePath), { recursive: true });
      appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch {
      // ディスクフル・権限等。ログ欠落より実行継続を優先する
    }
  }
}
