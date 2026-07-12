import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ChoEntry } from '../../shared/types';

/**
 * M42(TUKU-yomi): 月の帳 — 追記型のJSONLストア。
 *
 * 残るのは**抽出された一文だけ**。生ログ(音声・映像・文字起こし)は帳に入れない。
 * observation(見たこと)は7日で忘れる — 見たものは覚えるが、見たままは残さない(月の忘却)。
 * 約束・決定・ToDo は勇太さん自身のものだけ(主語は常に本人。他人をジャッジする記録は作らない)。
 *
 * ファイルパスは注入(ConfigStore / GodScheduler と同じ流儀。テストで tmp を渡す)。
 */

/** observation の保持日数。これを過ぎたものは prune() で消える */
export const OBSERVATION_TTL_DAYS = 7;

export class TsukiNoCho {
  constructor(
    private readonly filePath: string,
    private readonly nowFn: () => Date = () => new Date(),
  ) {}

  list(): ChoEntry[] {
    try {
      return readFileSync(this.filePath, 'utf8')
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => {
          try {
            return JSON.parse(l) as ChoEntry;
          } catch {
            return null; // 壊れた行は捨てる(追記型なので途中で切れた行がありうる)
          }
        })
        .filter((e): e is ChoEntry => e !== null && typeof e.id === 'string' && typeof e.text === 'string');
    } catch {
      return [];
    }
  }

  add(entry: Omit<ChoEntry, 'id' | 'ts'>): ChoEntry {
    const created: ChoEntry = { ...entry, id: randomUUID(), ts: this.nowFn().toISOString() };
    mkdirSync(dirname(this.filePath), { recursive: true });
    appendFileSync(this.filePath, `${JSON.stringify(created)}\n`, 'utf8');
    return created;
  }

  /** 約束・ToDo の完了。observation には done を付けない(観察は完了する種類のものではない) */
  setDone(id: string, done: boolean): ChoEntry | null {
    const all = this.list();
    const target = all.find((e) => e.id === id);
    if (target === undefined || target.kind === 'observation') return null;
    const updated = { ...target, done };
    this.rewrite(all.map((e) => (e.id === id ? updated : e)));
    return updated;
  }

  /**
   * 忘却: observation を7日で消す。約束・決定・ToDo は消さない
   * (覚えていることが本体なので、人が消すまで残る)
   */
  prune(): number {
    const all = this.list();
    const limit = this.nowFn().getTime() - OBSERVATION_TTL_DAYS * 24 * 60 * 60 * 1000;
    const kept = all.filter((e) => e.kind !== 'observation' || Date.parse(e.ts) >= limit);
    const removed = all.length - kept.length;
    if (removed > 0) this.rewrite(kept);
    return removed;
  }

  /** 追記型ファイルの作り直し(完了フラグ・忘却でのみ使う) */
  private rewrite(entries: ChoEntry[]): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const body = entries.map((e) => JSON.stringify(e)).join('\n');
    writeFileSync(this.filePath, body === '' ? '' : `${body}\n`, 'utf8');
  }

  exists(): boolean {
    return existsSync(this.filePath);
  }
}
