import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * M113-2: 一晩モードの途中保存(overnight-pending.json)。
 *
 * 一晩モードの待機中にアプリが再起動(クラッシュ/PC再起動/アップデート)すると、
 * インメモリの待機タイマーは消える。どの会話が「待機中に中断された」かだけを
 * 小さなファイルに残し、起動時に読み戻して該当会話を自動再開する。
 * 履歴そのものはセッション保存(既存)が持っているため、ここでは印だけで足りる。
 */

export interface OvernightPendingEntry {
  /** この時刻以降に再開してよい(ISO)。過去なら起動後すぐ再開 */
  resumeAt: string;
}

export type OvernightPendingMap = Record<string, OvernightPendingEntry>;

/** 読み込み。無い/壊れている場合は空(起動を止めない) */
export function loadOvernightPending(path: string): OvernightPendingMap {
  try {
    if (!existsSync(path)) return {};
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const out: OvernightPendingMap = {};
    for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'object' && v !== null && typeof (v as Record<string, unknown>)['resumeAt'] === 'string') {
        out[id] = { resumeAt: (v as Record<string, unknown>)['resumeAt'] as string };
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function saveOvernightPending(path: string, map: OvernightPendingMap): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(map, null, 1), 'utf8');
  } catch {
    // 保存失敗でランは止めない(再開印が消えるだけ)
  }
}
