import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CommunityCandidate, InboxItem, OperationsDraft } from '../../shared/types';

/**
 * M33-2: 受け箱(inbox)— 神々の成果物キュー。
 * 神エージェントはユーザーと直接話さず、成果をここへ投函する。
 * 神議が未読をまとめて読み、承認バッチに変換する(バラバラ通知の禁止)。
 * 追記型JSONL(userData/operations/inbox.jsonl)+既読はidリストで別管理。
 */

export type { InboxItem };

export class Inbox {
  private readonly itemsPath: string;
  private readonly readPath: string;

  constructor(dir: string) {
    this.itemsPath = join(dir, 'inbox.jsonl');
    this.readPath = join(dir, 'inbox-read.json');
  }

  post(item: Omit<InboxItem, 'id' | 'ts'>): InboxItem {
    const full: InboxItem = { ...item, id: randomUUID(), ts: new Date().toISOString() };
    try {
      mkdirSync(dirname(this.itemsPath), { recursive: true });
      appendFileSync(this.itemsPath, `${JSON.stringify(full)}\n`, 'utf8');
    } catch {
      // 投函失敗で神の実行自体は止めない
    }
    return full;
  }

  private readIds(): Set<string> {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.readPath, 'utf8'));
      return new Set(Array.isArray(parsed) ? (parsed as string[]) : []);
    } catch {
      return new Set();
    }
  }

  list(limit = 100): (InboxItem & { read: boolean })[] {
    const readIds = this.readIds();
    try {
      const lines = readFileSync(this.itemsPath, 'utf8')
        .split('\n')
        .filter((l) => l.trim() !== '');
      const out: (InboxItem & { read: boolean })[] = [];
      for (const line of lines.slice(-Math.max(0, limit))) {
        try {
          const parsed = JSON.parse(line) as InboxItem;
          if (typeof parsed.id === 'string') out.push({ ...parsed, read: readIds.has(parsed.id) });
        } catch {
          // 壊れた行はスキップ
        }
      }
      return out.reverse(); // 新しい順
    } catch {
      return [];
    }
  }

  unread(): InboxItem[] {
    return this.list(500).filter((i) => !i.read);
  }

  markRead(ids: string[]): void {
    const readIds = this.readIds();
    for (const id of ids) readIds.add(id);
    try {
      mkdirSync(dirname(this.readPath), { recursive: true });
      writeFileSync(this.readPath, JSON.stringify([...readIds]), 'utf8');
    } catch {
      // 既読管理はベストエフォート
    }
  }

  /**
   * M33-2: 後方互換の移行 — 受け箱導入前に生成済みの下書き・候補カードへ
   * 受け箱エントリを作る(1回だけ。inbox.jsonl が既にあれば何もしない)
   */
  migrateLegacy(drafts: OperationsDraft[], candidates: CommunityCandidate[]): number {
    if (existsSync(this.itemsPath)) return 0;
    let count = 0;
    for (const d of drafts) {
      if (d.status === 'discarded') continue;
      this.post({
        kind: 'draft',
        godId: 'ameno-uzume',
        title: `[移行] ${d.title}`,
        payload: { draftId: d.id, draftKind: d.kind },
      });
      count++;
    }
    for (const c of candidates) {
      if (c.status === 'discarded') continue;
      this.post({
        kind: 'candidate',
        godId: 'ameno-uzume',
        title: `[移行] 仲間候補(${c.verdict})`,
        payload: { candidateId: c.id, verdict: c.verdict },
      });
      count++;
    }
    return count;
  }
}
