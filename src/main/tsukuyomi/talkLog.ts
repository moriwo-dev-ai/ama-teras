import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { TalkEntry } from '../../shared/types';

/**
 * M43-2(TUKU-yomi): 会話ログ(左ペインの「TUKU-yomi」に出す履歴)。
 *
 * **ここには生の発話テキストが残る**(帳と違い、抽出前の言葉そのもの)。
 * 勇太さんの指示で残すことにした(2026-07-12)。したがって:
 *
 * - 置き場は userData の中だけ。**remote-ui(スマホ)へは中継しない**(BUS_CHANNELS に載せない)
 * - 上限を持ち、古いものから落とす(無限に貯めない)
 * - 「消す」を必ず用意する(残す物は消せなければならない)
 */

/** 保持する会話の件数。これを超えたら古い方から見えなくする */
export const TALK_LIMIT = 500;

export class TalkLog {
  constructor(
    private readonly filePath: string,
    private readonly nowFn: () => Date = () => new Date(),
  ) {}

  add(entry: Omit<TalkEntry, 'id' | 'ts'>): TalkEntry {
    const created: TalkEntry = { ...entry, id: randomUUID(), ts: this.nowFn().toISOString() };
    mkdirSync(dirname(this.filePath), { recursive: true });
    appendFileSync(this.filePath, `${JSON.stringify(created)}\n`, 'utf8');
    return created;
  }

  /** 新しい順ではなく**時系列**で返す(チャットなので下が最新) */
  list(): TalkEntry[] {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf8');
    } catch {
      return [];
    }
    const out: TalkEntry[] = [];
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (typeof parsed !== 'object' || parsed === null) continue;
        const rec = parsed as Record<string, unknown>;
        const role = rec['role'];
        const text = rec['text'];
        if ((role !== 'you' && role !== 'tsukuyomi' && role !== 'action') || typeof text !== 'string') {
          continue;
        }
        out.push({
          id: typeof rec['id'] === 'string' ? rec['id'] : randomUUID(),
          ts: typeof rec['ts'] === 'string' ? rec['ts'] : this.nowFn().toISOString(),
          role,
          text,
        });
      } catch {
        // 途中で電源が落ちた行(壊れたJSON)は飛ばす。ログ全体を捨てない
      }
    }
    return out.slice(-TALK_LIMIT);
  }

  /** 全部消す(残す物は消せなければならない) */
  clear(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, '', 'utf8');
  }
}
